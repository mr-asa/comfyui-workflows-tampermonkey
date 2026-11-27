"""Save userscript exports in one explicitly selected local folder."""

import argparse
import json
import re
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8191
MAX_REQUEST = 40 * 1024 * 1024
INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class SaveHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, **data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/save" or self.headers.get("Host") != f"{HOST}:{PORT}":
            self.reply(404, error="Unknown endpoint")
            return
        auth = self.headers.get("Authorization", "").encode("utf-8")
        if not secrets.compare_digest(auth, self.server.authorization):
            self.reply(401, error="Set the current save helper token in the Tampermonkey menu")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_REQUEST:
                raise ValueError("Invalid export size")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("Invalid export")
            folder = Path(data.get("folder", ""))
            if not folder.is_absolute() or folder.resolve() != self.server.folder:
                raise ValueError("The save path must match the folder authorized by the helper")
            filename = data.get("filename", "")
            if not isinstance(filename, str) or not re.fullmatch(r".+\.json", filename) or INVALID_NAME.search(filename):
                raise ValueError("Invalid JSON filename")
            if Path(filename).is_reserved():
                raise ValueError("Reserved JSON filename")
            content = data.get("json")
            if not isinstance(content, str):
                raise ValueError("Missing JSON text")
            content = content.encode("utf-8")
        except (TypeError, ValueError) as error:
            self.reply(400, error=str(error))
            return

        stem = filename[:-5]
        try:
            for index in range(1000):
                target = self.server.folder / (filename if not index else f"{stem} ({index}).json")
                try:
                    output = target.open("xb")
                except FileExistsError:
                    continue
                try:
                    with output:
                        output.write(content)
                except OSError:
                    target.unlink(missing_ok=True)
                    raise
                self.reply(201, filename=target.name)
                return
        except OSError:
            self.reply(500, error="The helper could not write to the authorized folder")
            return
        self.reply(409, error="Too many exports have the same filename")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="absolute destination folder")
    folder = parser.parse_args().folder
    if not folder.is_absolute():
        parser.error("enter an absolute folder path")
    folder = folder.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    with ThreadingHTTPServer((HOST, PORT), SaveHandler) as server:
        token = secrets.token_urlsafe(32)
        server.folder = folder
        server.authorization = f"Bearer {token}".encode()
        print(f"Folder: {folder}\nTampermonkey save helper token: {token}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
