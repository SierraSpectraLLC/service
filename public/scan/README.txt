opencv.js - OpenCV compiled to WebAssembly, vendored here on purpose.

WHY IT IS CHECKED IN RATHER THAN INSTALLED
  The receipt scanner (src/lib/scanDoc.ts) needs OpenCV's imgproc to find the
  edges of a piece of paper in a photo and flatten it. The npm packages that
  wrap it are awkward for this app in different ways: jscanify's main entry
  pulls `canvas` and `jsdom`, which means a native node-gyp build on every
  Vercel install for code that only ever runs in a browser; @techstark/opencv-js
  ships a fuller 13 MB build of the same thing. Both would also be bundled by
  webpack, which is a long build for a file that never changes.

  So it is a static asset. It is fetched from our own origin, cached by the
  CDN, and never from a third-party CDN at runtime - an engineer scanning a
  receipt on a client's locked-down lab wifi should not depend on unpkg being
  reachable, and a business app should not tell someone else's server which of
  our pages a person just opened.

HOW IT IS LOADED
  Never on page load. src/lib/scanDoc.ts injects the script the first time
  somebody actually taps "Scan receipt", and caches it for the rest of the
  session. Nobody who does not scan pays for it.

  The WASM is embedded in this file as a base64 data URI, so there is no
  second request and no locateFile() configuration - one file, self-contained.

WHERE IT CAME FROM
  The build published inside jscanify 1.4.3 (MIT), which is the stock
  OpenCV.js. jscanify's own scanner is 7 KB of OpenCV calls; we do that part
  ourselves in scanDoc.ts, where the document-mode pass and the corner
  handling live too.

LICENCE
  OpenCV is licensed under Apache License 2.0. See OPENCV-LICENSE.txt.
