# Website demo

The preview uses the desktop HTML, styles, components, and visualizer. `demo.js` supplies fictional stations and an in-memory player; it does not initialize the desktop API listeners or create audio.

After changing the app UI or the demo adapter, run `npm run build:site-demo` and commit the regenerated `index.html`, `app.js`, and `app.css` here. The source check in `tests/site-demo.test.js` catches stale generated files.

The three reactive backgrounds receive synthetic analyser data. Motion pauses when the preview is out of view, the tab is hidden, or the visitor pauses it. Reduced-motion visitors start with motion off and can enable it themselves. Reset clears the sample session.
