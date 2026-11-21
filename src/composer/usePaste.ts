// 画像とファイルの貼り付けとドロップ（#64、#69）。ccn の送信は文しか受けないので、手元のファイルのパスを文として入れる。受け手の Claude はパスを読む
import { useEffect, useRef, useState } from "react";
import { call as invoke, onFileDrop } from "../bridge";
import { insertPaths, type Edit, type Sel } from "./edit";

/** 別の機械のセッションには手元のパスが届かないので、画像とファイルは断る */
export const REMOTE_FILES = "別の機械のセッションには画像やファイルを渡せない（手元のパスは届かない）";

type Pasted = { files: string[]; image: string | null };

export function usePaste({ ta, local, canSend, searching, sel, apply, onError }: {
  ta: React.RefObject<HTMLTextAreaElement | null>;
  local: boolean;
  canSend: boolean;
  /** Ctrl+R の検索中か */
  searching: boolean;
  sel: () => Sel;
  apply: (e: Edit) => void;
  onError: (m: string) => void;
}) {
  const [dropping, setDropping] = useState(false);
  // 貼り付けとドロップの返事が来る前に、別のセッションへ替わって入力欄が消えていることがある
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const putText = (t: string) => {
    if (!alive.current || !ta.current) return;
    const s = sel();
    apply({ from: s.start, to: s.end, insert: t });
  };
  const putPaths = (paths: string[]) => {
    if (!alive.current || !ta.current) return;
    const ed = insertPaths(sel(), paths);
    if (ed) apply(ed);
  };
  // 受けたファイルが一時の場所（スクショのサムネの TemporaryItems など）にあれば、Claude Town が写したパスに替えてから入れる（#69）。
  // 受け手は一時の場所を読めず、サムネのファイルはすぐ消える。写せなければ理由を出して入れない
  const putFiles = (paths: string[]) =>
    invoke<string[]>("stage_files", { paths })
      .then((p) => putPaths(Array.isArray(p) ? p : paths))
      .catch((err) => onError(String(err)));
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData;
    // 文だけの貼り付けは、今までどおり textarea に任せる
    if (![...cd.items].some((i) => i.kind === "file")) return;
    const plain = cd.getData("text/plain");
    e.preventDefault();
    if (!local) {
      // Finder でコピーしたファイルは、文としてはファイル名が載っている。ファイルがあれば断る
      invoke<Pasted | null>("paste_clipboard", { saveImage: false })
        .then((r) => { if (!r?.files?.length && plain) putText(plain); else onError(REMOTE_FILES); })
        .catch(() => { if (plain) putText(plain); else onError(REMOTE_FILES); });
      return;
    }
    // Finder でコピーしたファイルは、webview からは名前しか見えないので、クリップボードを Rust で読む。
    // ファイルが無く、文も無いときだけ画像を保存する（表計算のセルのように、文と絵の両方が載っているものは文を入れる）
    invoke<Pasted | null>("paste_clipboard", { saveImage: !plain })
      .then((r) => {
        if (r?.files?.length) putFiles(r.files);
        else if (r?.image) putPaths([r.image]);
        else if (plain) putText(plain);
        else onError("クリップボードの画像を読めなかった");
      })
      .catch((err) => { if (plain) putText(plain); else onError(`貼り付けられなかった: ${err}`); });
  };
  // ドロップは窓のどこに落としても、開いている入力欄に入れる
  const dropRef = useRef({ local, canSend, searching, putFiles, onError });
  dropRef.current = { local, canSend, searching, putFiles, onError };
  useEffect(() => onFileDrop((e) => {
    if (e.type === "enter") setDropping(true);
    else if (e.type === "leave") setDropping(false);
    else if (e.type === "drop") {
      setDropping(false);
      const d = dropRef.current;
      // Ctrl+R の検索中は入れない（検索を閉じると、一致した文で入力欄が置き換わるため）
      if (!e.paths?.length || !d.canSend || d.searching) return;
      if (!d.local) { d.onError(REMOTE_FILES); return; }
      d.putFiles(e.paths);
    }
  }), []);

  return { dropping, onPaste };
}
