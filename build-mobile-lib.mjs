// build-mobile-lib.mjs
//
// Bundles public/lib.js (which imports npm packages like lodash, fuse.js, ...)
// into a single self-contained ES module, written directly into the Android
// APK assets at android/app/src/main/assets/public/lib.js.
//
// The normal SillyTavern server does this on the fly via webpack middleware
// (see webpack.config.js / src/middleware/webpack-serve.js). The standalone
// APK has no server, so we must run the same bundle step at build time —
// otherwise the WebView loads the raw source and fails with
// "Failed to resolve module specifier 'lodash'".

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const outputDir = path.join(__dirname, 'android', 'app', 'src', 'main', 'assets', 'public');

/** @type {import('webpack').Configuration} */
const config = {
    mode: 'production',
    entry: path.join(__dirname, 'public', 'lib.js'),
    devtool: false,
    target: 'web',
    experiments: {
        outputModule: true,
    },
    performance: {
        hints: false,
    },
    stats: {
        preset: 'minimal',
        colors: true,
    },
    output: {
        path: outputDir,
        filename: 'lib.js',
        libraryTarget: 'module',
    },
};

console.log('[build-mobile-lib] Bundling public/lib.js -> ' + path.join(outputDir, 'lib.js'));

webpack(config, (err, stats) => {
    if (err) {
        console.error('[build-mobile-lib] Fatal webpack error:', err);
        process.exit(1);
    }
    console.log(stats.toString({ preset: 'minimal', colors: true }));
    if (stats.hasErrors()) {
        console.error('[build-mobile-lib] Build failed with errors.');
        process.exit(1);
    }
    console.log('[build-mobile-lib] Done.');
});
