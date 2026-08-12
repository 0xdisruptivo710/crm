import { redirect } from "next/navigation"

// Entrada única do app: sempre encaminha para /inbox, que aplica a guarda
// de sessão (proxy.ts) e manda para /login quando não há sessão válida.
export default function Home() {
  redirect("/inbox")
}
