// Platform-event function: after every successful Hub deploy, ask the GM Digital Bunker site to
// rebuild, so its Publications page picks up artigos/index.json as now published.
//
//   quality_env deploy -> site quality-env build hook (SITE_HOOK_QUALIDADE)
//   main deploy        -> site main build hook (SITE_HOOK_PRODUCAO), only if that variable exists.
//                         It is deliberately not created until Gon orders production to be switched on.
//   anything else      -> nothing (deploy previews, other branches)
//
// The decision is made on the branch name, which Netlify records on every deploy. Hook URLs are
// secrets: they live only in environment variables (scope: Functions), never in code.
// No public route: Netlify signs platform events and blocks external calls.
import type { DeploySucceededEvent } from "@netlify/functions"

const HOOKS: Record<string, string> = {
  quality_env: "SITE_HOOK_QUALIDADE",
  main: "SITE_HOOK_PRODUCAO",
}

export default {
  async deploySucceeded(event: DeploySucceededEvent) {
    const deploy = event.deploy
    const branch = deploy.branch
    const context = deploy.context
    const commit = (deploy.commitRef || "").slice(0, 7)
    console.log(`[avisar-site] deploy ${deploy.id} branch=${branch} context=${context} commit=${commit}`)

    const varName = branch ? HOOKS[branch] : undefined
    if (!varName) {
      console.log("[avisar-site] branch not mapped to a site environment; nothing to do")
      return
    }
    const hook = Netlify.env.get(varName)
    if (!hook) {
      console.log(`[avisar-site] ${varName} is not set; site not notified (expected for production until enabled)`)
      return
    }
    const title = encodeURIComponent(`AI Strategy Hub ${branch} ${commit}`.trim())
    const res = await fetch(`${hook}?trigger_title=${title}`, { method: "POST" })
    console.log(`[avisar-site] build hook ${varName} -> HTTP ${res.status}`)
  },
}
