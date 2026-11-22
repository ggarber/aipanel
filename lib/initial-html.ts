// The welcome page every new panel starts with.
export const INITIAL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: system-ui, sans-serif; background: #f8fafc; color: #334155; }
  .hint { text-align: center; max-width: 28rem; padding: 2rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; color: #0f172a; }
</style>
</head>
<body>
  <div class="hint">
    <h1>Say what you want to see</h1>
    <p>Click the edit button in the bottom right (or hold it to talk) and describe a UI.
       Try “a todo list for a camping trip” or “a dashboard with three KPI cards”.</p>
  </div>
</body>
</html>`;
