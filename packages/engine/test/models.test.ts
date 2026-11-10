import { HashingEmbedder } from "@elevate/agent";
import { createDb, eq, messages, threads } from "@elevate/db";
import { FakeGitHub } from "@elevate/executors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chat, chatModelConfig, createThread, deleteThread, demoLLM, setModelPrefs, setThreadModel, type Ctx } from "../src";

describe("chat models and conversations", () => {
  const handle = createDb({ memory: true });
  let ctx: Ctx;

  beforeAll(async () => {
    await handle.ready;
    ctx = {
      db: handle.db,
      demo: true,
      llm: demoLLM(),
      embedder: new HashingEmbedder(),
      github: () => Promise.reject(new Error("offline")),
      writer: async () => new FakeGitHub(),
      token: async () => "t",
    };
  });
  afterAll(() => handle.close());

  it("a thread's own model beats the chat default, which beats the pipeline model", async () => {
    const t = await createThread(ctx);
    await setModelPrefs(ctx, { pipeline: "pipe-model", chat: "" });
    expect((await chatModelConfig(ctx, t.id)).model).toBe("pipe-model");
    await setModelPrefs(ctx, { chat: "chat-model" });
    expect((await chatModelConfig(ctx, t.id)).model).toBe("chat-model");
    await setThreadModel(ctx, t.id, "thread-model");
    expect((await chatModelConfig(ctx, t.id)).model).toBe("thread-model");
    await setThreadModel(ctx, t.id, null);
    expect((await chatModelConfig(ctx, t.id)).model).toBe("chat-model");
  });

  it("the picked model answers the next message", async () => {
    const t = await createThread(ctx);
    await setThreadModel(ctx, t.id, "gpt-5-mini");
    const text = await chat(ctx, t.id, "list my repos", () => {});
    expect(text).toContain("gpt-5-mini");
  });

  it("deleting a conversation removes its messages too, and only that conversation", async () => {
    const keep = await createThread(ctx);
    const gone = await createThread(ctx);
    await chat(ctx, keep.id, "what's on the radar?", () => {});
    await chat(ctx, gone.id, "what's on the radar?", () => {});
    expect(await deleteThread(ctx, gone.id)).toEqual({ deleted: 1 });
    expect(await ctx.db.select().from(threads).where(eq(threads.id, gone.id))).toHaveLength(0);
    expect(await ctx.db.select().from(messages).where(eq(messages.threadId, gone.id))).toHaveLength(0);
    expect(await ctx.db.select().from(messages).where(eq(messages.threadId, keep.id))).toHaveLength(2);
    expect(await deleteThread(ctx, gone.id)).toEqual({ deleted: 0 });
  });
});
