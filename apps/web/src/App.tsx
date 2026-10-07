import { useEffect, useMemo, useState } from "react";
import { Doc } from "@tandem/crdt";
import { Board } from "./components/Board";
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
    return new SyncClient({
      doc,
      boardId: board.boardId,
      token: board.token,
      userId: session.userId,
      name: session.name,
      color: colorFor(session.userId),
      url: `${API.replace(/^http/, "ws")}/ws`,
    });
  }, [session, board]);

  // StrictMode mounts, unmounts and remounts in dev; SyncClient.start() is
  // restartable so the socket is simply reopened.
  useEffect(() => {
    if (!client) return;
    void client.start();
    return () => client.close();
  }, [client]);

  if (!session) return <SignIn onSubmit={signIn} busy={busy} error={error} />;
  if (!board)
    return (
      <Lobby
        session={session}
        onCreate={createBoard}
        busy={busy}
        error={error}
      />
    );
  if (!client)
    return (
      <Lobby
        session={session}
        onCreate={createBoard}
        busy={busy}
        error={error}
      />
    );

  return (
    <div>
      <Board client={client} doc={client.doc} />
    </div>
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
