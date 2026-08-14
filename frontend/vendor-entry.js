// On force la résolution CommonJS (package.json "main") plutôt que la
// variante ESM (dist/modules-esm/*.mjs), qui contient un import relatif
// cassé dans certaines versions publiées de libsodium-wrappers.
window.sodium = require('libsodium-wrappers');
