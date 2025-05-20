import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
await esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outdir: 'dist',
    platform: 'node',
    target: 'es2020',
    sourcemap: true,
    external: ['vscode'],
    watch: watch ? { onRebuild: (error, result) => console.log(error ? 'Watch build failed' : 'Watch build succeeded') } : false
});