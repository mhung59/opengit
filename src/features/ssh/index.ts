/**
 * SSH: credential prompts of `ssh` / `git` child processes (askpass) and
 * Tools › Start SSH Session. The configurations live in Settings › Tools ›
 * SSH Configurations.
 */
import { onIdeEvent } from "@/platform/ipc";
import { registerOverlay } from "@/workbench/contributions";
import { dropAskpass, enqueueAskpass, useAskpass } from "./askpass";
import { AskpassHost } from "./AskpassDialog";

export function activate(): () => void {
  const disposers = [
    registerOverlay({ id: "ssh.askpass", component: AskpassHost }),
    onIdeEvent("askpass", (e) => enqueueAskpass({ id: e.id, prompt: e.prompt, kind: e.kind, remember: e.remember })),
    onIdeEvent("askpassDone", (e) => dropAskpass(e.id)),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    useAskpass.setState({ queue: [] });
  };
}
