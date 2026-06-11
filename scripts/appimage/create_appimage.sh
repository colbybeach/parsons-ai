#!/bin/bash

# Exit on error
set -e

# Check platform
platform=$(uname)

if [[ "$platform" == "Darwin" ]]; then
    echo "Running on macOS. Note that the AppImage created will only work on Linux systems."
    if ! command -v docker &> /dev/null; then
        echo "Docker Desktop for Mac is not installed. Please install it from https://www.docker.com/products/docker-desktop"
        exit 1
    fi
elif [[ "$platform" == "Linux" ]]; then
    echo "Running on Linux. Proceeding with AppImage creation..."
else
    echo "This script is intended to run on macOS or Linux. Current platform: $platform"
    exit 1
fi

# Enable BuildKit
export DOCKER_BUILDKIT=1

BUILD_IMAGE_NAME="void-appimage-builder"

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Please start Docker first."
    exit 1
fi

# Check and install Buildx if needed
if ! docker buildx version >/dev/null 2>&1; then
    echo "Installing Docker Buildx..."
    mkdir -p ~/.docker/cli-plugins/
    curl -SL https://github.com/docker/buildx/releases/download/v0.13.1/buildx-v0.13.1.linux-amd64 -o ~/.docker/cli-plugins/docker-buildx
    chmod +x ~/.docker/cli-plugins/docker-buildx
fi

# Download appimagetool if not present
if [ ! -f "appimagetool" ]; then
    echo "Downloading appimagetool..."
    wget -O appimagetool "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x appimagetool
fi

# Delete any existing AppImage to avoid bloating the build
rm -f Parsons-x86_64.AppImage

# Create build Dockerfile
echo "Creating build Dockerfile..."
cat > Dockerfile.build << 'EOF'
# syntax=docker/dockerfile:1
FROM ubuntu:20.04

# Install required dependencies
RUN apt-get update && apt-get install -y \
    libfuse2 \
    libglib2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxss1 \
    libxtst6 \
    libnss3 \
    libasound2 \
    libdrm2 \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
EOF

# Create .dockerignore file
echo "Creating .dockerignore file..."
cat > .dockerignore << EOF
Dockerfile.build
.dockerignore
.git
.gitignore
.DS_Store
*~
*.swp
*.swo
*.tmp
*.bak
*.log
*.err
node_modules/
venv/
*.egg-info/
*.tox/
dist/
EOF

# Build Docker image without cache
echo "Building Docker image (no cache)..."
docker build --no-cache -t "$BUILD_IMAGE_NAME" -f Dockerfile.build .

# Create AppImage using local appimagetool
echo "Creating AppImage..."
docker run --rm --privileged -v "$(pwd):/app" "$BUILD_IMAGE_NAME" bash -c '
cd /app && \
rm -rf ParsonsApp.AppDir && \
mkdir -p ParsonsApp.AppDir/usr/bin ParsonsApp.AppDir/usr/lib ParsonsApp.AppDir/usr/share/applications && \
find . -maxdepth 1 ! -name ParsonsApp.AppDir ! -name "." ! -name ".." -exec cp -r {} ParsonsApp.AppDir/usr/bin/ \; && \
cp parsons.png ParsonsApp.AppDir/ && \
echo "[Desktop Entry]" > ParsonsApp.AppDir/parsons.desktop && \
echo "Name=Parsons" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Comment=Open source AI code editor." >> ParsonsApp.AppDir/parsons.desktop && \
echo "GenericName=Text Editor" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Exec=parsons %F" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Icon=parsons" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Type=Application" >> ParsonsApp.AppDir/parsons.desktop && \
echo "StartupNotify=false" >> ParsonsApp.AppDir/parsons.desktop && \
echo "StartupWMClass=Parsons" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Categories=TextEditor;Development;IDE;" >> ParsonsApp.AppDir/parsons.desktop && \
echo "MimeType=application/x-parsons-workspace;" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Keywords=parsons;" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Actions=new-empty-window;" >> ParsonsApp.AppDir/parsons.desktop && \
echo "[Desktop Action new-empty-window]" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Name=New Empty Window" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Name[de]=Neues leeres Fenster" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Name[es]=Nueva ventana vacía" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Name[fr]=Nouvelle fenêtre vide" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Name[it]=Nuova finestra vuota" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Name[ja]=新しい空のウィンドウ" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Name[ko]=새 빈 창" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Name[ru]=Новое пустое окно" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Name[zh_CN]=新建空窗口" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Name[zh_TW]=開新空視窗" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Exec=parsons --new-window %F" >> ParsonsApp.AppDir/parsons.desktop && \
echo "Icon=parsons" >> ParsonsApp.AppDir/parsons.desktop && \
chmod +x ParsonsApp.AppDir/parsons.desktop && \
cp ParsonsApp.AppDir/parsons.desktop ParsonsApp.AppDir/usr/share/applications/ && \
echo "[Desktop Entry]" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "Name=Parsons - URL Handler" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "Comment=Open source AI code editor." > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "GenericName=Text Editor" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "Exec=parsons --open-url %U" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "Icon=parsons" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "Type=Application" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "NoDisplay=true" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "StartupNotify=true" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "Categories=Utility;TextEditor;Development;IDE;" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "MimeType=x-scheme-handler/parsons;" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
echo "Keywords=parsons;" > ParsonsApp.AppDir/parsons-url-handler.desktop && \
chmod +x ParsonsApp.AppDir/parsons-url-handler.desktop && \
cp ParsonsApp.AppDir/parsons-url-handler.desktop ParsonsApp.AppDir/usr/share/applications/ && \
echo "#!/bin/bash" > ParsonsApp.AppDir/AppRun && \
echo "HERE=\$(dirname \"\$(readlink -f \"\${0}\")\")" >> ParsonsApp.AppDir/AppRun && \
echo "export PATH=\${HERE}/usr/bin:\${PATH}" >> ParsonsApp.AppDir/AppRun && \
echo "export LD_LIBRARY_PATH=\${HERE}/usr/lib:\${LD_LIBRARY_PATH}" >> ParsonsApp.AppDir/AppRun && \
echo "exec \${HERE}/usr/bin/parsons --no-sandbox \"\$@\"" >> ParsonsApp.AppDir/AppRun && \
chmod +x ParsonsApp.AppDir/AppRun && \
chmod -R 755 ParsonsApp.AppDir && \

# Strip unneeded symbols from the binary to reduce size
strip --strip-unneeded ParsonsApp.AppDir/usr/bin/parsons

ls -la ParsonsApp.AppDir/ && \
ARCH=x86_64 ./appimagetool -n ParsonsApp.AppDir Parsons-x86_64.AppImage
'

# Clean up
rm -rf ParsonsApp.AppDir .dockerignore appimagetool

echo "AppImage creation complete! Your AppImage is: Parsons-x86_64.AppImage"
