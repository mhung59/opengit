import { render, screen, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("warms opted-in views while leaving occasional views to load on demand", async () => {
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.useFakeTimers();
  const { lazyComponent, prefetchLazyComponents } = await import("./lazy");
  const frequent = vi.fn(async () => () => <div>Git log</div>);
  const occasional = vi.fn(async () => () => <div>Settings</div>);
  lazyComponent(frequent, { preload: true });
  const Settings = lazyComponent(occasional);
  const cancel = prefetchLazyComponents();
  await vi.runAllTimersAsync();
  expect(frequent).toHaveBeenCalledTimes(1);
  expect(occasional).not.toHaveBeenCalled();
  await act(async () => {
    render(<Settings />);
  });
  expect(screen.getByText("Settings")).toBeInTheDocument();
  expect(occasional).toHaveBeenCalledTimes(1);
  cancel();
});

it("stops warming views when the project closes", async () => {
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.useFakeTimers();
  const { lazyComponent, prefetchLazyComponents } = await import("./lazy");
  const load = vi.fn(async () => () => <div>Diff</div>);
  lazyComponent(load, { preload: true });
  const cancel = prefetchLazyComponents();
  cancel();
  await vi.runAllTimersAsync();
  expect(load).not.toHaveBeenCalled();
});
