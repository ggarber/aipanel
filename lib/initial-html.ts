// The welcome page every new panel starts with.
export const INITIAL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #fff;
         font-family: system-ui, sans-serif;
         background: repeating-linear-gradient(135deg, rgb(255 255 255 / .035) 0 18px, transparent 18px 36px),
                     radial-gradient(ellipse at 50% -10%, #3f8cff 0%, #1d4fbf 35%, #0b1d4a 75%); }
  .hint { text-align: center; max-width: 30rem; margin: 1.5rem; padding: 1.75rem 2rem;
          background: linear-gradient(#2f6fe0, #1f4fb0); border: 3px solid #0e2257; border-radius: 18px;
          box-shadow: inset 0 3px 0 rgb(255 255 255 / .25), 0 6px 0 #0e2257, 0 12px 24px rgb(0 0 0 / .35); }
  h1 { margin: 0 0 .75rem; font-size: 2rem; font-weight: 900; letter-spacing: .02em; color: #ffd84a;
       -webkit-text-stroke: 2px #2a1300; paint-order: stroke fill; text-shadow: 0 4px 0 #2a1300; }
  p { margin: 0; line-height: 1.5; font-weight: 600; color: #dbe7ff; }
  em { font-style: normal; color: #ffe066; }
</style>
</head>
<body>
  <div class="hint">
    <h1>Say what you want to see</h1>
    <p>Click the gold button in the bottom right (or hold it to talk) and describe a UI.
       Try <em>“a todo list for a camping trip”</em> or <em>“a dashboard with three KPI cards”</em>.</p>
  </div>
</body>
</html>`;
