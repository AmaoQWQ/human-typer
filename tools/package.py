"""Build reproducible, allowlisted extension and source ZIPs. No dependencies."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
RUNTIME = ["manifest.json", "background.js", "content.js", "google-apps.js", "typing-behavior.js",
           "sidepanel.html", "sidepanel.css", "sidepanel.js", "LICENSE", "INSTALL.md"]
RUNTIME += [f"assets/icon-{size}.png" for size in (16, 32, 48, 128)] + ["assets/icon.svg"]
EXCLUDED = {"proofs", "dist", "design-system", ".git", ".codex", "node_modules", "__pycache__"}

def files_for_source():
    result = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z"], text=True)
    files = [name for name in result.split("\0") if name]
    if not files:
        raise RuntimeError("Stage the reviewed source files before building a source package.")
    for name in files:
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or EXCLUDED.intersection(relative.parts):
            raise RuntimeError("Unexpected source package path: " + name)
        if relative.name.startswith(".env") or relative.suffix in {".pem", ".key", ".crx", ".log"}:
            raise RuntimeError("Unexpected private source file: " + name)
        if (ROOT / relative).is_symlink():
            raise RuntimeError("Source package cannot dereference a symlink: " + name)
    return files

def write_zip(destination, files):
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name.replace("\\", "/"), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            data = (ROOT / name).read_bytes()
            if Path(name).suffix in {".js", ".cjs", ".py", ".html", ".css", ".json", ".yml", ".md", ".svg"} or Path(name).name in {"LICENSE", ".gitignore", ".gitattributes"}:
                data = data.replace(b"\r\n", b"\n")
            archive.writestr(info, data)
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip():
            raise RuntimeError("Corrupt archive")
        if set(archive.namelist()) != set(files):
            raise RuntimeError("Package file list mismatch")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest["name"] != "Human Typer":
            raise RuntimeError("Package branding mismatch")
        expected = [manifest["background"]["service_worker"], manifest["side_panel"]["default_path"], *manifest["icons"].values()]
        if not set(expected).issubset(archive.namelist()):
            raise RuntimeError("Missing extension entrypoints")

def main():
    version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
    DIST.mkdir(exist_ok=True)
    packages = [(DIST / f"human-typer-{version}.zip", RUNTIME),
                (DIST / f"human-typer-{version}-source.zip", files_for_source())]
    checksums = []
    for target, files in packages:
        write_zip(target, files)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        checksums.append(f"{digest}  {target.name}")
        print(f"Built {target.name}: {target.stat().st_size} bytes, {len(files)} files, SHA256 {digest}")
    (DIST / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", encoding="utf-8", newline="\n")

if __name__ == "__main__":
    main()
