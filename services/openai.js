import fs from 'fs';
import path from 'path';
import { AzureOpenAI } from 'openai';
import functionSchema from '../config/function_schema.json' with { type: 'json' };
import { getLastMessages, saveMessage } from './storage.js';

const systemPrompt = fs.readFileSync(path.resolve('config/system_prompt.txt'), 'utf8');

const endpoint = process.env.OPENAI_ENDPOINT;
const apiKey = process.env.OPENAI_KEY;
const deployment = process.env.OPENAI_DEPLOYMENT;
const apiVersion = process.env.OPENAI_VERSION;

const client = new AzureOpenAI({ endpoint, apiKey, deployment, apiVersion });

export async function getImageDescription(imageUrls) {
    if (!Array.isArray(imageUrls) || imageUrls.length === 0) return null;

    const messages = [
        {
            role: "system",
            content: "Beschreibe den Inhalt der folgenden Bilder möglichst genau. Achte auf erkennbare Objekte, Farben, Texte und visuelle Details. Was zeigen die Bilder? Gibt es erkennbare Zusammenhänge oder Auffälligkeiten?"
        },
        {
            role: "user",
            content: imageUrls.map(url => ({
                type: "image_url",
                image_url: { url }
            }))
        }
    ];

    try {
        const response = await client.chat.completions.create({
            model: deployment,
            messages,
            max_tokens: 500,
            temperature: 0.7,
            top_p: 0.9
        });

        return response.choices?.[0]?.message?.content || null;
    } catch (error) {
        console.error("❌ Fehler beim Abrufen der Bildbeschreibung:", error.message);
        return null;
    }
}

export async function getChatCompletion({ sessionId, role, text, userName, imageUrls }) {
    try {
        const functions = functionSchema;

        const messageTime = new Date().toLocaleString('de-DE', {
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone: 'Europe/Berlin' 
        });

        const history = await getLastMessages(sessionId, 20);

        let lastMessage = {
            role,
            content: [{ type: "text", text }]
        };

        if (Array.isArray(imageUrls) && imageUrls.length > 0) {
            for (const url of imageUrls) {
                lastMessage.content.push({
                    type: "image_url",
                    image_url: { url }
                });
            }
        }

        const enrichedSystemPrompt = `${systemPrompt}\n\nZeit jetzt: ${messageTime}\nUsername: ${userName || 'Benutzer'}`;

        const messages = [
            { role: "system", content: enrichedSystemPrompt },
            ...history.map(m => ({ role: m.role, content: m.message })),
            lastMessage
        ];

        console.log("➡️ OpenAI request payload:", JSON.stringify({
            messages,
            functions,
            function_call: "auto"
        }, null, 2));

        const response = await client.chat.completions.create({
            model: deployment,
            messages,
            functions,
            function_call: "auto",
            max_tokens: 1000,
            temperature: 0.9,
            top_p: 0.9
        });

        await saveMessage(sessionId, role, text);

        let imageDescription = null;
        if (Array.isArray(imageUrls) && imageUrls.length > 0) {
            imageDescription = await getImageDescription(imageUrls);
            if (imageDescription) {
                imageDescription = `Bild Link:\n${imageUrls.map(url => `${url}`).join('\n')}\nBildbeschreibung: ${imageDescription}`;
                await saveMessage(sessionId, "system", imageDescription);
            }
        }

        const choice = response.choices[0];
        if (!choice.message.function_call && choice.message.content) {
            await saveMessage(sessionId, 'assistant', choice.message.content);
        }
        return {
            reply: choice.message.content || "",
            functionCall: choice.message.function_call || null
        };
    } catch (error) {
        console.error("❌ Fehler beim Abrufen der Chat-Antwort:", error.message);
        return {
            reply: "⚠️ Die Anfrage konnte nicht verarbeitet werden. Bitte versuche es später erneut.",
            functionCall: null
        };
    }
}