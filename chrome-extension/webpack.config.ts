import path from 'path';
import CopyPlugin from 'copy-webpack-plugin';
import type { Configuration } from 'webpack';

const isProduction = process.env.NODE_ENV === 'production';

const config: Configuration = {
  mode: isProduction ? 'production' : 'development',
  // Ship no source maps in the production (Chrome Web Store) build — they'd
  // map the published bundle straight back to the original TypeScript,
  // which is unnecessary disclosure of internal source for a public listing.
  devtool: isProduction ? false : 'cheap-module-source-map',

  // ─── Entry Points ──────────────────────────────────────────────────────────
  // Each entry becomes a separate JS bundle loaded by the extension
  entry: {
    interceptor: './src/content/interceptor.ts',
    content: './src/content/content.ts',
    background: './src/background/service-worker.ts',
    popup: './src/popup/popup.ts',
  },

  // ─── Output ────────────────────────────────────────────────────────────────
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },

  // ─── Resolve ───────────────────────────────────────────────────────────────
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '../../../shared': path.resolve(__dirname, '../shared'),
    },
  },

  // ─── Loaders ───────────────────────────────────────────────────────────────
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },

  // ─── Plugins ───────────────────────────────────────────────────────────────
  plugins: [
    new CopyPlugin({
      patterns: [
        // Copy all static files from public/ to dist/
        { from: 'public', to: '.' },
      ],
    }),
  ],
};

export default config;
