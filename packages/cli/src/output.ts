import { Effect } from "effect"

// Bun's console and process.stdout use different buffers: an empty stdout write
// does not drain Console.log. Await each write before NodeRuntime can exit.
const line = (stream: NodeJS.WriteStream, value: string) =>
  Effect.callback<void>((resume) => {
    stream.write(`${value}\n`, () => resume(Effect.void))
  })

export const Console = {
  log: (value: string) => line(process.stdout, value),
  error: (value: string) => line(process.stderr, value),
}
