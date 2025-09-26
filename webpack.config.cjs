const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'production',
  entry: {
    background: './src/scripts/background.js',
    content: './src/scripts/content.js',
    popup: './src/scripts/popup.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  resolve: {
    extensions: ['.js'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@scripts': path.resolve(__dirname, 'src/scripts')
    }
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      }
    ]
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'manifest.json',
          to: 'manifest.json'
        },
        {
          from: 'src/pages/',
          to: 'pages/'
        },
        {
          from: 'assets/',
          to: 'assets/',
          noErrorOnMissing: true
        }
      ]
    })
  ],
  optimization: {
    minimize: false, // Keep readable for debugging
    splitChunks: false // Don't split chunks for Chrome extension
  },
  target: 'web',
  devtool: 'source-map'
}; 