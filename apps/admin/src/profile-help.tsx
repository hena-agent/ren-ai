const example = `## 공개 프로필

도자기를 만들고, 밤에는 오래 걸어요. 요즘 들은 음악 이야기부터 해볼까요?

### 기본 정보
- 나이: 26
- 직업: 도예가
- 지역: 서울

### 관심사
- 재즈
- 밤 산책

### 라이프스타일
- 주말: 동네 책방과 카페

### 관계 스타일
- 연락: 바빠도 하루 한 번은 안부 나누기

### 문답: 완벽한 일요일은?
늦잠 자고 좋아하는 동네를 걸어요.

### 내가 편해지는 순간
말이 없어도 어색하지 않을 때요.`;

export function ProfileHelp() {
  return (
    <dialog
      id="profile-help-dialog"
      className="portrait-dialog profile-help-dialog"
      aria-labelledby="profile-help-title"
    >
      <div className="profile-help-heading">
        <h2 id="profile-help-title" tabIndex={-1}>
          공개 프로필 작성법
        </h2>
        <button
          type="button"
          className="secondary"
          data-close-document-dialog
          aria-label="도움말 닫기"
        >
          ×
        </button>
      </div>
      <p>
        Persona 초안의 <code>## 공개 프로필</code> 아래를 수정하세요. 오른쪽 프리뷰에 그대로
        반영됩니다. 그 위의 인물 설정은 공개되지 않습니다.
      </p>
      <p className="hint">
        짧은 1인칭 자기소개로 시작하고, 필요한 항목만 ### 제목으로 추가하세요. 제목을 바꾸거나
        항목을 지우고 순서를 옮겨도 됩니다. 공개 프로필은 문서의 마지막에 한 번만 작성하세요.
      </p>
      <pre>
        <code>{example}</code>
      </pre>
    </dialog>
  );
}
