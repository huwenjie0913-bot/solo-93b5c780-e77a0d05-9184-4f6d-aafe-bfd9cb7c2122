#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
观众席视线校核台 —— 后端服务

仅依赖 Python 标准库：
  * wsgiref        提供 HTTP / WSGI 服务
  * sqlite3        多套布置的持久化
  * json / urllib  请求解析与路由

启动：
  python3 server.py            # 默认 0.0.0.0:8000
  python3 server.py 8888       # 指定端口
"""

import json
import os
import sqlite3
import sys
import time
import threading
from urllib.parse import urlparse
from wsgiref.simple_server import make_server, WSGIRequestHandler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(BASE_DIR, "sightline.db")

# ----------------------------------------------------------------------
# 数据层
# ----------------------------------------------------------------------

_db_lock = threading.Lock()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS layouts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,
                note       TEXT NOT NULL DEFAULT '',
                data_json  TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_layouts_updated ON layouts(updated_at)")


# ----------------------------------------------------------------------
# 业务逻辑
# ----------------------------------------------------------------------

def list_layouts():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, note, data_json, created_at, updated_at "
            "FROM layouts ORDER BY updated_at DESC"
        ).fetchall()
    return [_row_to_layout(r) for r in rows]


def get_layout(layout_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, name, note, data_json, created_at, updated_at "
            "FROM layouts WHERE id = ?",
            (layout_id,),
        ).fetchone()
    return _row_to_layout(row) if row else None


def create_layout(payload):
    name = _require_name(payload)
    note = str(payload.get("note", ""))
    data = _sanitize_data(payload.get("data"))
    now = time.time()
    with _db_lock, get_db() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO layouts (name, note, data_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (name, note, json.dumps(data, ensure_ascii=False), now, now),
            )
        except sqlite3.IntegrityError:
            raise HttpError(409, "同名布置已存在：%s" % name)
        layout_id = cur.lastrowid
    return get_layout(layout_id)


def update_layout(layout_id, payload):
    if get_layout(layout_id) is None:
        raise HttpError(404, "布置不存在")
    fields = []
    params = []
    if "name" in payload:
        name = _require_name(payload)
        fields.append("name = ?")
        params.append(name)
    if "note" in payload:
        fields.append("note = ?")
        params.append(str(payload["note"]))
    if "data" in payload:
        fields.append("data_json = ?")
        params.append(json.dumps(_sanitize_data(payload["data"]), ensure_ascii=False))
    if not fields:
        raise HttpError(400, "没有需要更新的字段")
    fields.append("updated_at = ?")
    params.append(time.time())
    params.append(layout_id)
    with _db_lock, get_db() as conn:
        try:
            conn.execute("UPDATE layouts SET %s WHERE id = ?" % ", ".join(fields), params)
        except sqlite3.IntegrityError:
            raise HttpError(409, "同名布置已存在")
    return get_layout(layout_id)


def delete_layout(layout_id):
    with _db_lock, get_db() as conn:
        cur = conn.execute("DELETE FROM layouts WHERE id = ?", (layout_id,))
    if cur.rowcount == 0:
        raise HttpError(404, "布置不存在")
    return {"deleted": layout_id}


def _row_to_layout(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "note": row["note"],
        "data": json.loads(row["data_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _require_name(payload):
    name = str(payload.get("name", "")).strip()
    if not name:
        raise HttpError(400, "布置名称不能为空")
    if len(name) > 80:
        raise HttpError(400, "布置名称过长（≤80 字）")
    return name


def _sanitize_data(data):
    """服务端只做宽松校验，保证存入的是合法 JSON 对象。"""
    if not isinstance(data, dict):
        raise HttpError(400, "data 必须是对象")
    if "rows" not in data or not isinstance(data["rows"], list):
        raise HttpError(400, "data.rows 必须是数组")
    if len(data["rows"]) > 500:
        raise HttpError(400, "排数过多（≤500）")
    return data


# ----------------------------------------------------------------------
# WSGI 层
# ----------------------------------------------------------------------

class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class QuietHandler(WSGIRequestHandler):
    def log_message(self, fmt, *args):  # 精简访问日志
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def application(environ, start_response):
    try:
        method = environ["REQUEST_METHOD"]
        path = urlparse(environ["SCRIPT_NAME"] + environ.get("PATH_INFO", "/")).path
        if path == "/":
            return serve_static("index.html", start_response)
        if path.startswith("/api/"):
            return route_api(method, path, environ, start_response)
        return serve_static(path.lstrip("/"), start_response)
    except HttpError as exc:
        return send_json(start_response, exc.status, {"error": exc.message})
    except Exception as exc:  # noqa: BLE001 — 兜底，避免连接挂起
        return send_json(start_response, 500, {"error": "服务器内部错误：%s" % exc})


def route_api(method, path, environ, start_response):
    parts = [p for p in path.split("/") if p]  # ['api', 'layouts', id?]
    if len(parts) >= 2 and parts[1] == "layouts":
        collection = len(parts) == 2
        layout_id = int(parts[2]) if len(parts) == 3 and parts[2].isdigit() else None
        if len(parts) == 3 and layout_id is None:
            raise HttpError(404, "未知接口")

        payload = read_json_body(environ) if method in ("POST", "PUT", "PATCH") else None

        if collection and method == "GET":
            return send_json(start_response, 200, {"layouts": list_layouts()})
        if collection and method == "POST":
            return send_json(start_response, 201, {"layout": create_layout(payload or {})})
        if layout_id is not None:
            if method == "GET":
                layout = get_layout(layout_id)
                if layout is None:
                    raise HttpError(404, "布置不存在")
                return send_json(start_response, 200, {"layout": layout})
            if method in ("PUT", "PATCH"):
                return send_json(start_response, 200, {"layout": update_layout(layout_id, payload or {})})
            if method == "DELETE":
                return send_json(start_response, 200, delete_layout(layout_id))
    raise HttpError(404, "未知接口：%s %s" % (method, path))


def read_json_body(environ):
    length = int(environ.get("CONTENT_LENGTH") or 0)
    if length <= 0:
        return {}
    if length > 2 * 1024 * 1024:
        raise HttpError(413, "请求体过大（≤2MB）")
    raw = environ["wsgi.input"].read(length)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HttpError(400, "请求体不是合法 JSON")
    if not isinstance(data, dict):
        raise HttpError(400, "请求体必须是 JSON 对象")
    return data


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def serve_static(rel_path, start_response):
    rel_path = rel_path or "index.html"
    safe = os.path.normpath(os.path.join(STATIC_DIR, rel_path))
    if not safe.startswith(STATIC_DIR + os.sep) or not os.path.isfile(safe):
        raise HttpError(404, "文件不存在：%s" % rel_path)
    ext = os.path.splitext(safe)[1]
    ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
    with open(safe, "rb") as fh:
        body = fh.read()
    start_response("200 OK", [
        ("Content-Type", ctype),
        ("Content-Length", str(len(body))),
        ("Cache-Control", "no-cache"),
    ])
    return [body]


def send_json(start_response, status, obj):
    code = {200: "200 OK", 201: "201 Created", 400: "400 Bad Request",
            404: "404 Not Found", 409: "409 Conflict", 413: "413 Payload Too Large",
            500: "500 Internal Server Error"}[status]
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    start_response(code, [
        ("Content-Type", "application/json; charset=utf-8"),
        ("Content-Length", str(len(body))),
    ])
    return [body]


def main():
    init_db()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    host = os.environ.get("HOST", "0.0.0.0")
    httpd = make_server(host, port, application, handler_class=QuietHandler)
    print("观众席视线校核台已启动： http://%s:%d/" % (host, port))
    print("按 Ctrl+C 停止服务。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
