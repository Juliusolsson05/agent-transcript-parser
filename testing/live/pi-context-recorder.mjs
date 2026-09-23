// Loaded INTO the real pi by pi-native-resume.live.test.ts (`pi -e`).
//
// A scripted model (Pi's own faux provider, so no login, network or quota)
// that writes the exact context Pi assembled for its model call to
// $PI_PARSER_CONTEXT_OUT, then answers. That context is the evidence: it is
// what Pi rebuilt from the projected session file, after its own loader,
// compaction projection and convertToLlm, not what the parser hoped for.
//
// Plain .mjs on purpose: Pi loads extensions through jiti, and keeping this
// out of the TypeScript projects means it never becomes parser source.
import { appendFileSync } from 'node:fs'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'

export default function (pi) {
  const faux = fauxProvider({ tokensPerSecond: 10000 })
  const respond = context => {
    appendFileSync(process.env.PI_PARSER_CONTEXT_OUT, JSON.stringify(context.messages ?? []) + '\n')
    return fauxAssistantMessage('Native resume acknowledged.')
  }
  faux.setResponses(Array.from({ length: 20 }, () => respond))
  pi.registerProvider(faux.provider)
}
