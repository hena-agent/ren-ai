export function cropRectangle(width: number, height: number, zoom: number, x: number, y: number) {
  const cropWidth = Math.min(width, (height * 4) / 5) / zoom;
  const cropHeight = (cropWidth * 5) / 4;
  return {
    x: ((width - cropWidth) * x) / 100,
    y: ((height - cropHeight) * y) / 100,
    width: cropWidth,
    height: cropHeight,
  };
}

export function cropBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("사진을 변환할 수 없습니다."));
      },
      "image/jpeg",
      0.92,
    ),
  );
}
