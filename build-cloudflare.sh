#!/bin/sh
# Build script for Cloudflare Pages - matches GitLab Pages behavior
mkdir -p public
for f in *; do
  if [ "$f" != "public" ] && [ "$f" != ".git" ] && [ "$f" != "build-cloudflare.sh" ]; then
    cp -r "$f" public/
  fi
done
echo "Build complete - files copied to public/"
ls -la public/
