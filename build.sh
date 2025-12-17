#!/bin/bash
# Simple build script for Cloudflare Pages
# Just copies everything to an output directory

echo "Creating build output..."
mkdir -p _site
cp -r *.html _site/ 2>/dev/null || true
cp -r css _site/ 2>/dev/null || true
cp -r js _site/ 2>/dev/null || true
cp -r icons _site/ 2>/dev/null || true
cp -r workers _site/ 2>/dev/null || true
cp _headers _site/ 2>/dev/null || true
echo "Build complete!"
ls -la _site/
