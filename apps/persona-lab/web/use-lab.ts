import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { Character } from "../src/loop.ts";
import type { SessionInfo } from "../src/store.ts";
import { createSession, exportSession, openSession, sessionAction, sessionsFor } from "./api.ts";
import { locationFromPath, showLocation } from "./location.ts";

const messageOf = (cause: Error | string): string =>
  cause instanceof Error ? cause.message : cause;

const hasChanged = (previous: Character, fresh: Character): boolean =>
  fresh.entries.length >= previous.entries.length &&
  fresh.decisions.length >= previous.decisions.length &&
  (fresh.entries.length !== previous.entries.length ||
    fresh.decisions.length !== previous.decisions.length ||
    fresh.nextCheckAt !== previous.nextCheckAt ||
    fresh.offset !== previous.offset);

export const useLab = () => {
  const [persona, setPersona] = useState(() =>
    typeof window === "undefined" ? "harin" : locationFromPath(window.location.pathname).persona,
  );
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [current, setCurrent] = useState<Character | null>(null);
  const [observedAt, setObservedAt] = useState(0);
  const [text, setText] = useState("");
  const [kind, setKind] = useState("user");
  const [minutes, setMinutes] = useState("5");
  const [changes, setChanges] = useState("아직 변경이 없습니다.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const currentRef = useRef<Character | null>(null);
  const generation = useRef(0);
  const working = useRef(false);

  const update = useCallback((value: Character | null) => {
    currentRef.current = value;
    setCurrent(value);
    setObservedAt(Date.now());
    if (value)
      setSessions((list) =>
        list.map((info) =>
          info.id === value.session.id ? { ...info, events: value.session.events.length } : info,
        ),
      );
  }, []);

  const start = useCallback(
    async (selected: string, preferredId: string | null, mode: "push" | "replace") => {
      const version = ++generation.current;
      setPersona(selected);
      update(null);
      setError("");
      setChanges("아직 변경이 없습니다.");
      try {
        let list = await sessionsFor(selected);
        if (version !== generation.current) return;
        const chosen = list.find((info) => info.id === preferredId) ?? list[0];
        let selectedSession: Character;
        if (chosen) selectedSession = await openSession(chosen.id);
        else {
          selectedSession = await createSession(selected);
          list = await sessionsFor(selected);
        }
        if (version !== generation.current) return;
        setSessions(list);
        update(selectedSession);
        showLocation(selected, selectedSession.session.id, mode);
      } catch (cause) {
        if (version === generation.current)
          setError(messageOf(cause instanceof Error ? cause : "세션을 불러오지 못했습니다."));
      }
    },
    [update],
  );

  useEffect(() => {
    const restore = () => {
      const { persona: selected, sessionId } = locationFromPath(window.location.pathname);
      void start(selected, sessionId, "replace");
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [start]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const existing = currentRef.current;
      if (!existing || working.current) return;
      const version = generation.current;
      void (async () => {
        try {
          const fresh = await openSession(existing.session.id);
          const previous = currentRef.current;
          if (
            version === generation.current &&
            !working.current &&
            previous?.session.id === fresh.session.id &&
            hasChanged(previous, fresh)
          )
            update(fresh);
        } catch (cause) {
          if (version === generation.current)
            setError(messageOf(cause instanceof Error ? cause : "세션을 불러오지 못했습니다."));
        }
      })();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [update]);

  const act = async (
    action: () => Promise<Character>,
    message?: string,
    onSuccess?: (value: Character) => void,
  ): Promise<boolean> => {
    if (working.current) return false;
    working.current = true;
    const version = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const value = await action();
      if (version !== generation.current) return false;
      update(value);
      onSuccess?.(value);
      if (message) setChanges(message);
      return true;
    } catch (cause) {
      if (version === generation.current)
        setError(messageOf(cause instanceof Error ? cause : "요청을 처리하지 못했습니다."));
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const selectPersona = (selected: string) => {
    if (!working.current) void start(selected, null, "push");
  };

  const selectSession = (id: string) => {
    if (working.current) return;
    const version = ++generation.current;
    setError("");
    void (async () => {
      try {
        const value = await openSession(id);
        if (version === generation.current) {
          update(value);
          setChanges("아직 변경이 없습니다.");
          showLocation(persona, value.session.id, "push");
        }
      } catch (cause) {
        if (version === generation.current)
          setError(messageOf(cause instanceof Error ? cause : "세션을 불러오지 못했습니다."));
      }
    })();
  };

  const newSession = () => {
    let list: SessionInfo[] = [];
    void act(
      async () => {
        const created = await createSession(persona);
        list = await sessionsFor(persona);
        return created;
      },
      "새 세션을 시작했습니다.",
      (created) => {
        setSessions(list);
        showLocation(persona, created.session.id, "push");
      },
    );
  };

  const reset = () => {
    if (current && window.confirm("이 세션의 대화와 판단 기록을 모두 초기화할까요?"))
      void act(() => sessionAction("reset", current.session.id), "초기화되었습니다.");
  };

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!current || !text.trim() || working.current) return;
    const value = text.trim();
    const sessionId = current.session.id;
    void (async () => {
      const sent = await act(
        () =>
          sessionAction("input", sessionId, {
            body: JSON.stringify({ id: crypto.randomUUID(), kind, text: value }),
          }),
        "메시지를 보냈습니다. 잠시 뒤 답장이 도착합니다.",
      );
      if (sent && currentRef.current?.session.id === sessionId)
        setText((draft) => (draft === text ? "" : draft));
    })();
  };

  const tick = () => {
    if (current) void act(() => sessionAction("tick", current.session.id, { minutes }));
  };

  const download = async () => {
    if (!current) return;
    try {
      const file = new Blob([await exportSession(current.session.id)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `persona-${current.session.id.slice(0, 8)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setError("");
    } catch (cause) {
      setError(messageOf(cause instanceof Error ? cause : "기록을 내려받지 못했습니다."));
    }
  };

  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !current || !window.confirm("저장한 기록을 새 세션으로 불러올까요?")) return;
    const id = current.session.id;
    let importedPersona = persona;
    let list: SessionInfo[] = [];
    void act(
      async () => {
        const imported = await sessionAction("import", id, { body: await file.text() });
        const all = await sessionsFor("");
        const info = all.find((entry) => entry.id === imported.session.id);
        if (!info) throw new Error("세션을 불러오지 못했습니다.");
        importedPersona = info.persona;
        list = all.filter((entry) => entry.persona === importedPersona);
        return imported;
      },
      "저장된 응답으로 재현했습니다.",
      (imported) => {
        setPersona(importedPersona);
        setSessions(list);
        showLocation(importedPersona, imported.session.id, "push");
      },
    );
  };

  return {
    persona,
    sessions,
    current,
    observedAt,
    text,
    setText,
    kind,
    setKind,
    minutes,
    setMinutes,
    changes,
    error,
    busy,
    selectPersona,
    selectSession,
    newSession,
    reset,
    send,
    tick,
    download,
    importFile,
  };
};
