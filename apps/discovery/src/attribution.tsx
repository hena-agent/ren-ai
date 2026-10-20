import { useCopy } from "./locale.tsx";

export function Attribution() {
  return (
    <p className="sidebar-note">
      {useCopy().attribution}{" "}
      <a href="https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea">
        NVIDIA Nemotron-Personas-Korea
      </a>
      {" · "}
      <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
    </p>
  );
}
