import { useEffect, useMemo, useState } from "react";
import { Doc } from "@tandem/crdt";
import { Board } from "./components/Board";
import { ChaosDemo } from "./components/ChaosDemo";
import { SyncClient } from "./lib/sync";
import { colorFor } from "./lib/board";

const API = import.meta.env.VITE_API ?? "http://localhost:8080";

interface Session {
  userId: string;
  token: string;
  name: string;
}

interface BoardRef {
  boardId: string;
  token: string;
}

function readJson(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

export default function App(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = localStorage.getItem("tandem.session");
    return raw ? (JSON.parse(raw) as Session) : null;
  });
  const [board, setBoard] = useState<BoardRef | null>(() => {
    const url = new URL(location.href);
    const boardId = url.searchParams.get("board");
    const token = url.searchParams.get("token");
    if (boardId && token) return { boardId, token };
    const raw = localStorage.getItem("tandem.board");
    return raw ? (JSON.parse(raw) as BoardRef) : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const url = new URL(location.href);
    if (board && url.searchParams.get("board") !== board.boardId) {
      url.searchParams.set("board", board.boardId);
      url.searchParams.set("token", board.token);
      history.replaceState(null, "", url.toString());
      localStorage.setItem("tandem.board", JSON.stringify(board));
    }
  }, [board]);

  async function signIn(
    email: string,
    password: string,
    mode: "login" | "register",
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok)
        throw new Error(
          mode === "register"
            ? "Could not create that account"
            : "Wrong email or password",
        );
      const data = (await readJson(res)) as { userId: string; token: string };
      const s: Session = {
        userId: data.userId,
        token: data.token,
        name: email.split("@")[0] ?? "guest",
      };
      localStorage.setItem("tandem.session", JSON.stringify(s));
      setSession(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function createBoard(): Promise<void> {
    if (!session) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/boards`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.token}`,
        },
        body: "{}",
      });
      if (!res.ok) throw new Error("Could not create a board");
      const data = (await readJson(res)) as { boardId: string };
      setBoard({ boardId: data.boardId, token: session.token });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a board");
    } finally {
      setBusy(false);
    }
  }

  const client = useMemo(() => {
    if (!session || !board) return null;
    const doc = new Doc(session.userId);
    const deviceKey = `tandem.device:${board.boardId}:${session.userId}`;
    return new SyncClient({
      doc,
      boardId: board.boardId,
      token: board.token,
      userId: session.userId,
      // per board and identity: the server signs it for exactly that actor
      device: localStorage.getItem(deviceKey) ?? "",
      onDevice: (token) => localStorage.setItem(deviceKey, token),
      name: session.name,
      color: colorFor(session.userId),
      url: `${API.replace(/^http/, "ws")}/ws`,
    });
  }, [session, board]);

  // Tabs of one browser share a device token, hence a CRDT actor; two of them
  // editing one board would collide on (actor, seq). Only the tab holding the
  // board's lock opens it; another waits and takes over when that tab closes.
  const [lockHeld, setLockHeld] = useState(false);
  useEffect(() => {
    if (!board) return;
    const abort = new AbortController();
    let release: (() => void) | undefined;
    navigator.locks
      .request(
        `tandem-board-${board.boardId}`,
        { signal: abort.signal },
        () => {
          setLockHeld(true);
          return new Promise<void>((r) => (release = r));
        },
      )
      .catch(() => {
        // aborted while still waiting for the other tab
      });
    return () => {
      abort.abort();
      release?.();
      setLockHeld(false);
    };
  }, [board]);

  // StrictMode mounts, unmounts and remounts in dev; SyncClient.start() is
  // restartable so the socket is simply reopened.
  useEffect(() => {
    if (!client || !lockHeld) return;
    void client.start();
    return () => client.close();
  }, [client, lockHeld]);

  // hash navigation (e.g. #chaos) must be state, not read once: a hash change
  // fires no React render on its own
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onHash = (): void => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!session) return <SignIn onSubmit={signIn} busy={busy} error={error} />;
  if (board && !lockHeld)
    return (
      <div style={center}>
        <p>This board is open in another tab of this browser.</p>
        <p style={{ color: "#666", fontSize: 14 }}>
          It opens here as soon as that tab is closed.
        </p>
      </div>
    );
  if (!board || !client)
    return (
      <Lobby
        session={session}
        onCreate={createBoard}
        busy={busy}
        error={error}
      />
    );

  if (hash === "#chaos") {
    return (
      <div>
        <p style={{ margin: "12px 16px 0" }}>
          <a href={location.pathname + location.search}>
            &larr; back to the board
          </a>
        </p>
        <ChaosDemo token={board.token} />
      </div>
    );
  }

  return (
    <div>
      <Board client={client} doc={client.doc} />
      <div
        style={{
          position: "fixed",
          bottom: 8,
          right: 12,
          fontSize: 12,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
        }}
      >
        <SharePanel board={board} />
        <a href="#chaos">chaos demo</a>
      </div>
    </div>
  );
}

function SharePanel({ board }: { board: BoardRef }): React.JSX.Element {
  const [links, setLinks] = useState<{ role: string; url: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function createLinks(): Promise<void> {
    setError(null);
    try {
      const out = [];
      for (const role of ["editor", "viewer"] as const) {
        const res = await fetch(`${API}/boards/${board.boardId}/share`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${board.token}`,
          },
          body: JSON.stringify({ role, ttlSeconds: 7 * 24 * 3600 }),
        });
        if (!res.ok)
          throw new Error(
            res.status === 403 || res.status === 401
              ? "Only the board owner can share it"
              : "Could not create share links",
          );
        const { token } = (await readJson(res)) as { token: string };
        const url = new URL(location.pathname, location.origin);
        url.searchParams.set("board", board.boardId);
        url.searchParams.set("token", token);
        out.push({ role, url: url.toString() });
      }
      setLinks(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not share");
    }
  }

  return (
    <>
      {links.map((l) => (
        <label key={l.role} style={{ display: "flex", gap: 6 }}>
          {l.role} link
          <input
            readOnly
            value={l.url}
            onFocus={(e) => e.currentTarget.select()}
            style={{ width: 220, fontSize: 12 }}
          />
        </label>
      ))}
      {error && <span style={{ color: "#c0392b" }}>{error}</span>}
      <button onClick={() => void createLinks()}>Share</button>
    </>
  );
}

function SignIn({
  onSubmit,
  busy,
  error,
}: {
  onSubmit: (
    email: string,
    password: string,
    mode: "login" | "register",
  ) => Promise<void>;
  busy: boolean;
  error: string | null;
}): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("register");
  return (
    <div style={center}>
      <h1 style={{ fontSize: 22 }}>Tandem</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Realtime whiteboard with a hand-rolled CRDT engine.
      </p>
      <form
        style={{ display: "flex", flexDirection: "column", gap: 8, width: 260 }}
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit(email, password, mode);
        }}
      >
        <input
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          placeholder="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && (
          <span style={{ color: "#c0392b", fontSize: 13 }}>{error}</span>
        )}
        <button disabled={busy} type="submit">
          {mode === "register" ? "Create account" : "Sign in"}
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === "register" ? "login" : "register")}
          style={{
            background: "none",
            border: "none",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {mode === "register"
            ? "I already have an account"
            : "Create a new account"}
        </button>
      </form>
    </div>
  );
}

function Lobby({
  session,
  onCreate,
  busy,
  error,
}: {
  session: Session;
  onCreate: () => Promise<void>;
  busy: boolean;
  error: string | null;
}): React.JSX.Element {
  return (
    <div style={center}>
      <h1 style={{ fontSize: 20 }}>Hi {session.name}</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Open a shared board with ?board=&token= in the URL, or start your own.
      </p>
      {error && <span style={{ color: "#c0392b", fontSize: 13 }}>{error}</span>}
      <button disabled={busy} onClick={() => void onCreate()}>
        New board
      </button>
    </div>
  );
}

const center: React.CSSProperties = {
  height: "100dvh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
};
