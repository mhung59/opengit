import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerAskpass, askpassAnswer, dropAskpass, enqueueAskpass, useAskpass } from "./askpass";

describe("askpass queue", () => {
  beforeEach(() => useAskpass.setState({ queue: [] }));

  it("queues prompts in arrival order, once each", () => {
    enqueueAskpass({ id: 1, prompt: "Password:", kind: "secret", remember: false });
    enqueueAskpass({ id: 2, prompt: "Continue connecting (yes/no)?", kind: "confirm", remember: false });
    enqueueAskpass({ id: 1, prompt: "Password:", kind: "secret", remember: false });
    expect(useAskpass.getState().queue.map((p) => p.id)).toEqual([1, 2]);
  });

  it("drops a prompt answered elsewhere", () => {
    enqueueAskpass({ id: 1, prompt: "a", kind: "text", remember: false });
    enqueueAskpass({ id: 2, prompt: "b", kind: "text", remember: false });
    dropAskpass(1);
    dropAskpass(9);
    expect(useAskpass.getState().queue.map((p) => p.id)).toEqual([2]);
  });

  it("answers the backend and shows the next prompt", () => {
    const send = vi.fn((_id: number, _answer: string | null, _remember: boolean) => Promise.resolve());
    enqueueAskpass({ id: 1, prompt: "a", kind: "secret", remember: true });
    enqueueAskpass({ id: 2, prompt: "b", kind: "secret", remember: false });
    answerAskpass({ id: 1, prompt: "a", kind: "secret", remember: true }, "hunter2", true, send);
    expect(send).toHaveBeenCalledWith(1, "hunter2", true);
    expect(useAskpass.getState().queue.map((p) => p.id)).toEqual([2]);
  });

  it("maps choices to answers", () => {
    expect(askpassAnswer("secret", { text: "pw" })).toBe("pw");
    expect(askpassAnswer("text", { text: "" })).toBe("");
    expect(askpassAnswer("confirm", { confirm: true })).toBe("yes");
    expect(askpassAnswer("confirm", { confirm: false })).toBe("no");
    expect(askpassAnswer("secret", null)).toBeNull();
    expect(askpassAnswer("confirm", null)).toBeNull();
  });
});
