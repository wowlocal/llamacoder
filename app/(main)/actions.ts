"use server";

import { getPrisma } from "@/lib/prisma";
import {
  getMainCodingPrompt,
  screenshotToCodePrompt,
  softwareArchitectPrompt,
} from "@/lib/prompts";
import { notFound } from "next/navigation";
import Together from "together-ai";

export async function createChat(
  prompt: string,
  model: string,
  quality: "high" | "low",
  screenshotUrl: string | undefined,
) {
  try {
    const prisma = getPrisma();
    console.log("[createChat] prompt:", prompt);
    console.log("[createChat] model:", model);
    console.log("[createChat] quality:", quality);
    console.log("[createChat] screenshotUrl:", screenshotUrl);
    const chat = await prisma.chat.create({
      data: {
        model,
        quality,
        prompt,
        title: "",
        shadcn: true,
      },
    });

    let options: ConstructorParameters<typeof Together>[0] = {};
    if (process.env.HELICONE_API_KEY) {
      options.baseURL = "https://together.helicone.ai/v1";
      options.defaultHeaders = {
        "Helicone-Auth": `Bearer ${process.env.HELICONE_API_KEY}`,
        "Helicone-Property-appname": "LlamaCoder",
        "Helicone-Session-Id": chat.id,
        "Helicone-Session-Name": "LlamaCoder Chat",
      };
      console.log("[createChat] Using Helicone API with options:", options);
    }

    const together = new Together(options);

    async function fetchTitle() {
      const responseForChatTitle = await together.chat.completions.create({
        model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
        messages: [
          {
            role: "system",
            content:
              "You are a chatbot helping the user create a simple app or script, and your current job is to create a succinct title, maximum 3-5 words, for the chat given their initial prompt. Please return only the title.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      });
      console.log("[createChat] responseForChatTitle:", responseForChatTitle);
      const title = responseForChatTitle.choices[0].message?.content || prompt;
      return title;
    }

    async function fetchTopExample() {
      const findSimilarExamples = await together.chat.completions.create({
        model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
        messages: [
          {
            role: "system",
            content: `You are a helpful bot. Given a request for building an app, you match it to the most similar example provided. If the request is NOT similar to any of the provided examples, return "none". Here is the list of examples, ONLY reply with one of them OR "none":

          - landing page
          - blog app
          - quiz app
          - pomodoro timer
          `,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      });
      console.log("[createChat] findSimilarExamples:", findSimilarExamples);
      const mostSimilarExample =
        findSimilarExamples.choices[0].message?.content || "none";
      return mostSimilarExample;
    }

    const [title, mostSimilarExample] = await Promise.all([
      fetchTitle(),
      fetchTopExample(),
    ]);
    console.log("[createChat] title:", title);
    console.log("[createChat] mostSimilarExample:", mostSimilarExample);

    let fullScreenshotDescription;
    if (screenshotUrl) {
      const screenshotResponse = await together.chat.completions.create({
        model: "meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo",
        temperature: 0.2,
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: screenshotToCodePrompt },
              {
                type: "image_url",
                image_url: {
                  url: screenshotUrl,
                },
              },
            ],
          },
        ],
      });
      console.log("[createChat] screenshotResponse:", screenshotResponse);
      fullScreenshotDescription = screenshotResponse.choices[0].message?.content;
      console.log("[createChat] fullScreenshotDescription:", fullScreenshotDescription);
    }

    let userMessage: string;
    if (quality === "high") {
      let initialRes = await together.chat.completions.create({
        model: "Qwen/Qwen2.5-Coder-32B-Instruct",
        messages: [
          {
            role: "system",
            content: softwareArchitectPrompt,
          },
          {
            role: "user",
            content: fullScreenshotDescription
              ? fullScreenshotDescription + prompt
              : prompt,
          },
        ],
        temperature: 0.2,
        max_tokens: 3000,
      });
      console.log("[createChat] initialRes:", initialRes);
      userMessage = initialRes.choices[0].message?.content ?? prompt;
      console.log("[createChat] userMessage (high quality):", userMessage);
    } else if (fullScreenshotDescription) {
      userMessage =
        prompt +
        "RECREATE THIS APP AS CLOSELY AS POSSIBLE: " +
        fullScreenshotDescription;
      console.log("[createChat] userMessage (low quality, with screenshot):", userMessage);
    } else {
      userMessage = prompt;
      console.log("[createChat] userMessage (low quality, no screenshot):", userMessage);
    }

    let newChat = await prisma.chat.update({
      where: {
        id: chat.id,
      },
      data: {
        title,
        messages: {
          createMany: {
            data: [
              {
                role: "system",
                content: getMainCodingPrompt(mostSimilarExample),
                position: 0,
              },
              { role: "user", content: userMessage, position: 1 },
            ],
          },
        },
      },
      include: {
        messages: true,
      },
    });
    console.log("[createChat] newChat:", newChat);

    const lastMessage = newChat.messages
      .sort((a, b) => a.position - b.position)
      .at(-1);
    if (!lastMessage) throw new Error("No new message");
    console.log("[createChat] lastMessage:", lastMessage);

    return {
      chatId: chat.id,
      lastMessageId: lastMessage.id,
    };
  } catch (error) {
    if (error instanceof Error) {
      console.error("[createChat] Error:", error.message, error.stack);
    } else {
      try {
        // Try to stringify the error for more details
        console.error("[createChat] Unknown error:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
      } catch (stringifyErr) {
        // Fallback if error is not serializable
        console.error("[createChat] Unknown error (non-serializable):", error);
      }
    }
    throw error;
  }
}

export async function createMessage(
  chatId: string,
  text: string,
  role: "assistant" | "user",
) {
  const prisma = getPrisma();
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { messages: true },
  });
  if (!chat) notFound();

  const maxPosition = Math.max(...chat.messages.map((m) => m.position));

  const newMessage = await prisma.message.create({
    data: {
      role,
      content: text,
      position: maxPosition + 1,
      chatId,
    },
  });

  return newMessage;
}
