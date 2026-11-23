#!/usr/bin/env python3
"""Tauri の命令の「包み」と「中身の関数」の対を数える（#106 の手順4）。

src-tauri/src の .rs を読み、各ファイルの `mod cmd { ... }` に手で書いた `#[tauri::command]` の関数（包み）と、
同じファイルの `mod cmd` の外にある同名の関数（中身）の対を出す。対は2つに分ける。

- 素通し: 包みの引数（名前と型）と戻り値が中身と同じで、本文が blocking で中身を呼ぶだけ。署名を二重に書いている
- 変換: 名前は同じだが、引数の型、戻り値、前処理のどれかが違う

    python3 scripts/count-cmd-signatures.py            # 対と件数
    python3 scripts/count-cmd-signatures.py --names    # generate_handler! の命令を「名前(引数名, ...)」で整列して出す
    python3 scripts/count-cmd-signatures.py --check    # 素通しの対が1つでもあれば終了コード 1

--names は、`#[tauri::command]` を付けた関数と crate::blocking_command! で包んだ関数から引数名を取る。
generate_handler! の命令に定義が見つからないとき、定義の数と generate_handler! の数がずれたときは、終了コード 1 で終わる。
移動の前後で --names の出力を diff し、命令名と引数名が変わっていないことを見る。
"""
import pathlib
import re
import sys

SRC = pathlib.Path(__file__).resolve().parent.parent / "src-tauri" / "src"
SIG = r"fn\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([^{;]+?))?\s*(?:\{|where)"


def block_end(text: str, open_brace: int) -> int:
    """open_brace の位置の { に対応する } の位置。// の注釈と "..." の中は数えない"""
    depth = 0
    i = open_brace
    while i < len(text):
        c = text[i]
        if text.startswith("//", i):
            i = text.find("\n", i)
            if i < 0:
                break
            continue
        if c == '"':
            i += 1
            while i < len(text) and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise SystemExit(f"閉じ括弧が見つからない: {open_brace}")


def norm(s: str | None) -> str:
    s = re.sub(r"\s+", "", s or "")
    return s.replace("super::", "").replace("serde_json::", "").replace("crate::", "")


def args_of(raw: str) -> list[tuple[str, str]]:
    out = []
    for a in re.split(r",(?![^<]*>)", raw):
        if ":" in a:
            n, t = a.split(":", 1)
            out.append((n.strip(), norm(t)))
    return out


def body_of(text: str, sig_end: int) -> str:
    start = text.index("{", sig_end - 1)
    return re.sub(r"\s+", " ", text[start + 1:block_end(text, start)]).strip()


def main() -> int:
    pure, adapt, wrappers_only = [], [], []
    defined: dict[str, list[str]] = {}
    for path in sorted(SRC.rglob("*.rs")):
        text = path.read_text()
        rel = path.relative_to(SRC.parent.parent)
        # 命令の定義（引数名の一覧のため）。#[tauri::command] を付けた関数と、blocking_command! で包んだ関数
        for m in re.finditer(r"(?:#\[tauri::command[^\]]*\]\s*(?:///[^\n]*\n\s*)*|blocking_command!\s*\{\s*(?:(?:///[^\n]*|#\[[^\]]*\])\s*)*)(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?" + SIG, text):
            if "$" in m.group(0):
                continue  # マクロの定義そのもの
            defined.setdefault(m.group(1), []).append(f"{rel}: " + ", ".join(n for n, _ in args_of(m.group(2))))
        cm = re.search(r"^\s*(?:pub(?:\([a-z]+\))?\s+)?mod cmd\s*\{", text, re.M)
        if not cm:
            continue
        start = cm.end() - 1
        end = block_end(text, start)
        inside = text[start:end]
        outside = text[:cm.start()] + text[end + 1:]
        inner = {f.group(1): f for f in re.finditer(r"\b" + SIG, outside)}
        for w in re.finditer(r"#\[tauri::command[^\]]*\]\s*pub\s+async\s+" + SIG, inside):
            name = w.group(1)
            f = inner.get(name)
            if not f:
                wrappers_only.append(f"{rel}: {name}")
                continue
            same_sig = args_of(w.group(2)) == args_of(f.group(2)) and norm(w.group(3)) == norm(f.group(3))
            body = body_of(inside, w.end())
            call = ", ".join(n for n, _ in args_of(w.group(2)))
            forward = body in (
                f"crate::blocking(move || super::{name}({call})).await",
                f"blocking(move || super::{name}({call})).await",
                f"crate::blocking(super::{name}).await",
            )
            row = f"{rel}: {name}({call})"
            (pure if same_sig and forward else adapt).append(row)

    names_only = "--names" in sys.argv
    out = sys.stderr if names_only else sys.stdout
    print("素通しの対（署名を二重に書いている）:", file=out)
    print("".join(f"  {r}\n" for r in pure), end="", file=out)
    print("変換の対（名前は同じで、型か戻り値か前処理が違う）:", file=out)
    print("".join(f"  {r}\n" for r in adapt), end="", file=out)
    print("包みだけ（中身の名前が違う）:", file=out)
    print("".join(f"  {r}\n" for r in wrappers_only), end="", file=out)
    print(f"素通し {len(pure)}、変換 {len(adapt)}、包みだけ {len(wrappers_only)}", file=out)

    lib = (SRC / "lib.rs").read_text()
    h = re.search(r"generate_handler!\[(.*?)\]", lib, re.S)
    if not h:
        print("generate_handler! が見つからない", file=sys.stderr)
        return 1
    handler = sorted(p.strip().split("::")[-1] for p in h.group(1).split(",") if p.strip())
    print(f"generate_handler! の命令 {len(handler)}、定義 {sum(len(v) for v in defined.values())}", file=out)
    if "--names" in sys.argv:
        bad = False
        for name in handler:
            defs = defined.get(name, [])
            if len(defs) != 1:
                print(f"{name}: 定義が {len(defs)} 個ある", file=sys.stderr)
                bad = True
                continue
            print(f"{name}({defs[0].split(': ', 1)[1]})")
        if bad:
            return 1
    if sum(len(v) for v in defined.values()) != len(handler):
        print("定義の数と generate_handler! の数が合わない", file=sys.stderr)
        return 1
    if "--check" in sys.argv and pure:
        print(f"素通しの包みが {len(pure)} 個残っている。crate::blocking_command! で中身の定義を包む", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
