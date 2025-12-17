#!/bin/sh
# Build script for Cloudflare Pages
# Copy everything to _worker.js location to signal deployment
echo "Preparing static site deployment..."

# The presence of files at root should be enough
# But let's ensure index.html exists
if [ -f "index.html" ]; then
    echo "✓ index.html found at root"
    ls -la index.html
else
    echo "✗ ERROR: index.html not found!"
    exit 1
fi

echo "Build complete - ready to deploy from root"
