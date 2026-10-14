export function UploadControls({
  portraitStyle: style,
  locked,
  full,
}: {
  portraitStyle: "anime" | "photo";
  locked: boolean;
  full: boolean;
}) {
  return (
    <div
      className="upload-drop"
      data-upload-drop={style}
      aria-label={`${style === "photo" ? "실사" : "애니풍"} 사진 업로드`}
    >
      <button
        type="button"
        className="secondary"
        data-upload-style={style}
        disabled={locked || full}
      >
        사진 업로드
      </button>
      <span className="hint">파일을 여기에 드롭 · PNG/JPEG/WebP · 20MB 이하</span>
    </div>
  );
}

export function UploadDialog() {
  return (
    <>
      <input type="file" data-upload-file accept="image/png,image/jpeg,image/webp" hidden />
      <output data-upload-status className="hint" aria-live="polite" />
      <dialog data-upload-dialog aria-labelledby="upload-title" className="upload-dialog">
        <h2 id="upload-title">사진 크롭 · 4:5</h2>
        <p className="hint">프로필에 보일 영역을 조정하세요. 업로드 후 저장해야 공개됩니다.</p>
        <canvas data-upload-canvas width={1024} height={1280} aria-label="크롭 결과 미리보기" />
        <label htmlFor="crop-zoom">
          확대
          <input
            id="crop-zoom"
            data-crop-zoom
            type="range"
            min="100"
            max="300"
            step="1"
            defaultValue="100"
          />
        </label>
        <label htmlFor="crop-x">
          가로 위치
          <input id="crop-x" data-crop-x type="range" min="0" max="100" defaultValue="50" />
        </label>
        <label htmlFor="crop-y">
          세로 위치
          <input id="crop-y" data-crop-y type="range" min="0" max="100" defaultValue="50" />
        </label>
        <div className="form-actions">
          <button type="button" data-upload-cancel className="secondary">
            취소
          </button>
          <button type="button" data-upload-confirm>
            크롭해서 업로드
          </button>
        </div>
        <output data-upload-status className="hint" aria-live="polite" />
      </dialog>
    </>
  );
}
