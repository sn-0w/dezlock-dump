# Building an Interactive Binary Analysis Viewer in a Single HTML File

When I needed a way to browse schema dumps from a game engine -- tens of thousands of classes, hundreds of thousands of fields, live memory values changing sixty times a second -- I decided to build the entire viewer as a single HTML file. No bundler, no framework, no dependencies. One file you can double-click from your filesystem and start working.

This post walks through the engineering decisions behind that viewer: how it handles 150MB+ JSON payloads, how the data layer is structured for instant lookups, how search and routing work without a framework, and how the live entity inspector renders real-time memory values over WebSocket.

## The Constraint: One File, Zero Dependencies

The viewer ships alongside a C++ binary analysis tool. Users get a JSON export and an HTML file. That is the entire delivery mechanism. The constraints are deliberate:

- **No build step.** Clone the repo, open the file. No `npm install`, no Webpack config, no dev server.
- **Works offline.** Opens from `file://` with no CORS issues. Useful when you are on an air-gapped machine reverse-engineering a binary.
- **Easy to distribute.** One file means one attachment, one download, one thing to keep in sync with the dump tool's version.

The entire viewer -- HTML, CSS, and roughly 3,000 lines of JavaScript -- lives in `viewer/index.html` at around 147KB uncompressed.

## Handling 150MB+ JSON Files

The raw JSON export from a full schema dump can exceed 150MB. A significant portion of that is vtable function bytes: 128-byte hex strings for every function prologue captured during scanning. The viewer does not need those bytes, so the first optimization happens during parsing.

### Web Worker for Parsing

Parsing 150MB of JSON on the main thread freezes the browser for 5-10 seconds. The viewer creates a Web Worker from an inline blob to move parsing off the UI thread:

```js
const WORKER_SRC = `
self.onmessage = function(e) {
  var msg = e.data;
  if (msg.type === 'parse') {
    try {
      self.postMessage({type:'status', text:'Parsing JSON...'});
      var data = JSON.parse(msg.text);
      // Strip vtable function bytes to save memory (~70% of file)
      var mods = data.modules || [];
      for (var i = 0; i < mods.length; i++) {
        var vts = mods[i].vtables || [];
        for (var j = 0; j < vts.length; j++) {
          var fns = vts[j].functions || [];
          for (var k = 0; k < fns.length; k++) { delete fns[k].bytes; }
        }
      }
      self.postMessage({type:'done', data: data});
    } catch(err) {
      self.postMessage({type:'error', message: err.message});
    }
  }
};
`;

var blob = new Blob([WORKER_SRC], {type: 'application/javascript'});
worker = new Worker(URL.createObjectURL(blob));
```

The worker source is defined as a string constant and turned into a Blob URL. This avoids needing a separate `.js` file while keeping the parsing truly off-thread. If Web Workers are unavailable (some restrictive `file://` contexts), the viewer falls back to main-thread parsing with a `setTimeout` to at least allow the UI to paint a loading message first.

### Progress Reporting

The `FileReader.onprogress` event reports bytes-read during the initial file read (mapped to 0-50% on the progress bar). The worker posts `status` messages during parsing (50-80%), and the indexing phase fills in the rest.

## Architecture Overview

### Data Layer: Maps Built Once, Queried Everywhere

After parsing, the `onDataReady` function builds three core lookup structures:

```js
classMap = new Map();    // className -> {m: module, o: classObj, mods: [modules]}
enumMap  = new Map();    // enumName  -> {m: module, o: enumObj}
childrenMap = new Map(); // parentName -> [childName, ...]
```

Every subsequent operation -- rendering a class detail view, resolving a type link, building the inheritance tree -- reads from these maps. Lookups are O(1). The alternative, scanning arrays on every interaction, would be unacceptable with 30,000+ classes.

A flat `searchEntries` array is also built during indexing. Each entry is a compact tuple: `[name, category, module, context]`. Categories are single characters (`'c'` for class, `'e'` for enum, `'f'` for field, `'g'` for global, `'v'` for enum value). This array is sent to the worker for search queries.

### Search: Off-Thread with Request IDs

Search is delegated to the same Web Worker that handled parsing. When the user types in the sidebar search box, a debounced handler posts a `search` message with the current query and a monotonically increasing request ID:

```js
worker.postMessage({
  type: 'search',
  query: query,
  entries: searchEntries,
  requestId: ++searchReqId
});
```

The worker does a linear scan with scoring (exact match > prefix match > substring match, with a category bonus so classes rank above fields), then returns the top 200 results. The response carries the same `requestId`, and the main thread discards results from stale queries:

```js
if (msg.requestId === searchReqId) {
  searchResolve(msg.results);
}
```

This pattern -- debounce plus request ID invalidation -- is simple but handles the common race condition where a slow query's results arrive after a faster subsequent query has already completed.

### Hash-Based Routing

The viewer uses `location.hash` for navigation. Every class, enum, global, and protobuf message has a URL of the form `#class/module/ClassName` or `#enum/module/EnumName`. The `handleHash` function splits the hash into segments and dispatches:

```js
function handleHash() {
  var hash = decodeURIComponent(location.hash.slice(1));
  if (!hash || !D) return;
  var p = hash.split('/');
  if (p[0] === 'class' && p.length >= 3) {
    setTab('classes');
    activeItem = {type:'class', module:p[1], name:p.slice(2).join('/')};
    renderContent();
  }
  // ... enum, globals, tree, protobuf, entities
}
window.addEventListener('hashchange', handleHash);
```

Using `p.slice(2).join('/')` handles class names that might contain slashes. The browser's back and forward buttons work naturally because `hashchange` fires for history navigation. No router library needed.

### Module Filtering

The dump contains classes spread across many game modules (DLLs). A `moduleFilter` Set controls visibility across all views. Toggling a module checkbox adds or removes the module name from the Set, then rebuilds the sidebar list. The filter applies uniformly: sidebar items, search results, tree views, and globals all respect the same Set.

## The Live Entity Inspector

When connected to the C++ live bridge over WebSocket, the viewer unlocks an entity browser tab: a split-pane interface with an entity list on the left and a field-level inspector on the right.

### WebSocket Client

The `LiveClient` class wraps a WebSocket connection with a request/response protocol. Each outgoing message carries an auto-incrementing `id`, and the client keeps a `pending` Map of resolve/reject callbacks:

```js
send(cmd, args) {
  return new Promise((resolve, reject) => {
    if (!this.ws || this.ws.readyState !== 1)
      return reject(new Error('not connected'));
    var id = ++this.reqId;
    this.pending.set(id, { resolve, reject });
    this.ws.send(JSON.stringify({ id, cmd, args: args || {} }));
    setTimeout(() => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }
    }, 5000);
  });
}
```

Server-pushed messages (those without an `id`) are routed through `_handlePush`, which dispatches on the `cmd` field. A periodic ping measures latency and displays it in the header.

### Subscription-Based Updates with Polling Fallback

The inspector prefers server-side subscriptions. When you select an entity, the viewer calls `mem.subscribe` with the entity's address, module, class name, and a 100ms interval:

```js
var result = await liveClient.subscribe(addr, mod, className, 100,
  function(changes) {
    updateInspectorFields(changes, mod, className);
  }
);
```

The server pushes `mem.diff` messages containing only the fields that changed since the last tick. If subscription is not supported (older server versions), the viewer falls back to polling `mem.read_object` every 500ms with a `setInterval`.

### Rich Type Rendering

The server sends typed values with a `_t` discriminator. The `renderLiveValue` function dispatches on this tag to specialized renderers:

- **Booleans** render as disabled checkboxes.
- **Colors** render as an inline swatch plus RGBA text.
- **Vectors** (Vec3, QAngle) render as labeled components (`x`, `y`, `z`) with drag-to-scrub interaction via `cursor: ew-resize`.
- **Pointers** render as clickable addresses that can be drilled into recursively.
- **Handles** (CHandle) render as `ent:N seq:M` badges that, when clicked, navigate to the referenced entity.
- **Enums** resolve numeric values to named constants using the schema's enum definitions.
- **Structs** render as collapsible inline trees.

Each renderer builds DOM nodes programmatically using `document.createElement`. The viewer avoids `innerHTML` for live values to prevent XSS from crafted game strings.

### Recursive Drill-Down

Pointer fields display a clickable address. Clicking it sends a `mem.deref` request to the server, which reads the pointed-to memory and returns either a string, a structured object with fields, or raw hex bytes. The result is rendered as a nested tree under the pointer field:

```js
var result = await liveClient.send('mem.deref', {
  addr: addr, type: fieldType, module: module || '', size: 64
});
```

Clicking again collapses the drill-down. This lets you chase pointer chains through complex object graphs without leaving the inspector.

### Diff Highlighting

Changed fields are tracked with a `entityInspChanged` Set and a rolling `entityInspSnapshot` object (JSON-stringified values keyed by field name). When a new value differs from the snapshot, the viewer triggers a CSS animation:

```css
.live-diff-flash { animation: diffFlash .6s ease-out; }
@keyframes diffFlash {
  0%   { background: rgba(232, 93, 117, 0.3); }
  100% { background: transparent; }
}
```

The animation is re-triggered by removing the class, forcing a reflow with `void td.offsetWidth`, then re-adding it. Users can also take a frozen snapshot and filter to show only fields that changed relative to that point, which is useful for isolating what a specific game action modifies.

## Performance Considerations

- **Capped rendering.** The sidebar limits to 5,000 DOM nodes; the entity list caps at 1,000 rows. Beyond that, users must use the search/filter. True virtual scrolling was considered but the cap approach is simpler and sufficient.
- **CSS-only animations.** Diff flash highlighting uses a CSS `@keyframes` animation rather than JavaScript-driven timers, keeping the main thread free during high-frequency updates.
- **`textContent` over `innerHTML`.** All user-facing values (field names, class names, live memory values) are set via `textContent` or `document.createElement`, never via `innerHTML` with string interpolation. The `esc()` utility exists for the few places where HTML construction is unavoidable.
- **Delegated event handlers.** The inspector tree attaches a single click listener on the tree wrapper that uses `e.target.closest('.insp-drilldown-toggle')` to handle drill-down clicks, rather than binding handlers to each of the potentially thousands of pointer fields.
- **Document fragments.** Sidebar list rendering builds into a `DocumentFragment` before appending to the DOM, avoiding layout thrashing during large list updates.

## The Single-File Trade-Off

**Where it works well:**

- Distribution is trivial. Users do not need Node.js, Python, or any toolchain.
- No CORS issues when opening from `file://`. No dev server required.
- The file is self-contained and versioned alongside the dump tool in the same repository.
- Works in any modern browser on any OS without configuration.

**Where it hurts:**

- No hot module reload during development. Every change requires a manual browser refresh.
- At 3,400+ lines in one file, refactoring requires discipline. Sections are delimited by comment banners (`// ===== Section Name =====`), but there is no module system enforcing boundaries.
- CSS is inlined at the top, meaning the style section alone is 300+ lines that you scroll past constantly.
- Adding a significant new feature means the file keeps growing. At some point this approach stops scaling, but for a focused tool with a clear scope, it has not hit that wall yet.

## Key Takeaways

1. **Web Workers for heavy parsing are non-negotiable.** If your data file is measured in megabytes, parse it off-thread. The inline Blob URL pattern keeps the worker self-contained without needing a separate file.

2. **Build your lookup maps once during load.** The time spent constructing `classMap`, `enumMap`, and `childrenMap` pays for itself every time you render a view, resolve a type link, or run a search.

3. **Debounce + request ID is the simplest way to handle async search.** You do not need RxJS or a cancellation token system. A counter and a stale-check on the response is enough.

4. **Hash routing is underrated.** For tools that do not need nested routes or middleware, `location.hash` plus `hashchange` gives you deep linking, history navigation, and shareable URLs with zero dependencies.

5. **Prefer subscriptions, fall back to polling.** The subscription model (`mem.subscribe` with server-pushed diffs) is dramatically more efficient than polling full object reads, but having the polling fallback means the viewer works with any server version.

6. **Single-file distribution is a legitimate architecture for developer tools.** The trade-offs in maintainability are real, but the deployment simplicity is hard to beat when your users are engineers who just want to open a file and start working.

---

*Part of the [dezlock-dump](https://github.com/dougwithseismic/dezlock-dump) technical series.*
