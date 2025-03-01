import { Client, GatewayIntentBits, Message } from 'discord.js';
import axios from 'axios';
import * as dotenv from 'dotenv';
import schedule from 'node-schedule';

dotenv.config();

if (!process.env.DISCORD_TOKEN || !process.env.WEBHOOK_ID || !process.env.API_ENDPOINT) {
  throw new Error('Missing required environment variables');
}

interface Payload {
  query_post?: string;
  webhook: string;
}

interface TaskContext {
  taskId: string;
  originalMessage: Message;
  queryType: string;
}

interface WebhookResult {
  input: {
    query_post: string;
  };
  result: string;
  task_output: Array<{
    name: string;
    result: string;
  }>;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const WEBHOOK_ID = process.env.WEBHOOK_ID;
const WEBHOOK_URL = `https://webhook.site/${WEBHOOK_ID}`;
const WEBHOOK_FETCH_URL = `https://webhook.site/token/${WEBHOOK_ID}/requests?sorting=newest`;
const taskContexts = new Map<string, TaskContext>();
const processedWebhookIds = new Set<string>();

client.on('ready', () => {
  console.log(`Logged in as ${client.user?.tag}!`);
  schedule.scheduleJob('*/1 * * * *', checkWebhookResults);
});

client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;

  if (message.content.startsWith('!runcrew')) {
    try {
      console.log(`Received command: ${message.content}`);
      await message.reply('🔄 Processing your request...');

      const response = await callCustomAPI(message);
      const taskId = response.Task_id;

      const queryType = detectQueryType(message.content);
      taskContexts.set(taskId, { taskId, originalMessage: message, queryType });

      console.log(`Task created successfully! Task ID: ${taskId}`);
      await message.reply(`🚀 Task created successfully!\nTask ID: ${taskId}`);
      
      // Add a timeout to check if response is taking too long
      setTimeout(() => {
        if (taskContexts.has(taskId)) {
          message.reply('⏳ Still waiting for results. This may take a few more minutes.');
        }
      }, 60000); // Check after 1 minute
    } catch (error) {
      console.error('API Error:', error);
      message.reply('❌ Error processing your request: ' + (error.message || 'Unknown error'));
    }
  }
});

function detectQueryType(content: string): string {
  const query = content.toLowerCase();
  if (query.includes('research')) return 'research';
  if (query.includes('blog') || query.includes('copywriting')) return 'blog';
  if (query.includes('twitter') || query.includes('x')) return 'twitter';
  return 'general';
}

async function checkWebhookResults() {
  try {
    console.log('Fetching webhook results...');

    const response = await axios.get(WEBHOOK_FETCH_URL);
    const webhookRequests = response.data.data;

    console.log(`Found ${webhookRequests.length} webhook requests`);

    for (const request of webhookRequests) {
      // Skip already processed webhooks
      if (processedWebhookIds.has(request.uuid)) {
        continue;
      }
      
      try {
        console.log('Processing new webhook response:', request.uuid);

        if (!request.content || request.content.trim() === '') {
          console.warn('Empty webhook content, skipping');
          processedWebhookIds.add(request.uuid);
          continue;
        }

        const result = JSON.parse(request.content);
        
        // Look at the query_post field from the input
        const queryText = result.input?.query_post;
        console.log(`Query text from webhook: "${queryText}"`);
        
        // Check all task contexts and find the one that matches by topic, not by ID
        const taskIds = Array.from(taskContexts.keys());
        console.log(`Current task IDs: ${taskIds.join(', ')}`);
        
        // Find a matching task - any task will do since we're looking for content matches
        let matchFound = false;
        
        for (const taskId of taskIds) {
          const context = taskContexts.get(taskId);
          // Extract the command content from the original message
          const messageContent = context.originalMessage.content;
          const commandText = messageContent.substring(messageContent.indexOf(' ') + 1).trim();
          
          console.log(`Comparing: "${queryText}" vs "${commandText}"`);
          
          // Check if the query text is related to the command
          if (
            queryText.toLowerCase().includes(commandText.toLowerCase()) || 
            commandText.toLowerCase().includes(queryText.toLowerCase())
          ) {
            console.log(`Found matching task ID: ${taskId} for query: ${queryText}`);
            await formatAndSendResponse(result, context);
            taskContexts.delete(taskId);
            matchFound = true;
          }
        }
        
        if (!matchFound) {
          console.warn(`No matching task found for query: ${queryText}`);
        }

        processedWebhookIds.add(request.uuid);
      } catch (error) {
        console.error('Error processing webhook response:', error);
        processedWebhookIds.add(request.uuid);
      }
    }
    
    // Limit the size of processed IDs set to prevent memory leaks
    if (processedWebhookIds.size > 1000) {
      const idsArray = Array.from(processedWebhookIds);
      const newIds = idsArray.slice(idsArray.length - 500);
      processedWebhookIds.clear();
      newIds.forEach(id => processedWebhookIds.add(id));
    }
  } catch (error) {
    console.error('Error retrieving webhook data:', error);
  }
}

async function formatAndSendResponse(result: WebhookResult, context: TaskContext) {
  try {
    console.log("Full result object:", JSON.stringify(result, null, 2));
    
    let extractedData = extractRelevantData(result, context.queryType);
    console.log(`Extracted Data for Task ID ${context.taskId}: ${extractedData}`);

    if (!extractedData || extractedData.trim() === '') {
      extractedData = "No results were returned from the API. Please try again.";
    }

    const maxLength = 1900; // Discord message limit is 2000, leaving room for extra chars
    if (extractedData.length > maxLength) {
      const chunks = splitMessage(extractedData, maxLength);
      for (const [index, chunk] of chunks.entries()) {
        await context.originalMessage.reply(`Part ${index + 1}/${chunks.length}:\n${chunk}`);
      }
    } else {
      await context.originalMessage.reply(extractedData);
    }
  } catch (error) {
    console.error('Error formatting response:', error);
    await context.originalMessage.reply('⚠️ Error formatting results: ' + (error.message || 'Unknown error'));
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let currentChunk = '';
  
  // Split by paragraphs first to try to keep logical blocks together
  const paragraphs = text.split('\n\n');
  
  for (const paragraph of paragraphs) {
    // If a single paragraph is too long, split it further
    if (paragraph.length > maxLength) {
      const sentences = paragraph.split('. ');
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length + 2 <= maxLength) {
          currentChunk += sentence + '. ';
        } else {
          chunks.push(currentChunk.trim());
          currentChunk = sentence + '. ';
        }
      }
    } else if (currentChunk.length + paragraph.length + 2 <= maxLength) {
      currentChunk += paragraph + '\n\n';
    } else {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph + '\n\n';
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

function extractRelevantData(result: WebhookResult, queryType: string): string {
  let extractedContent = '';

  try {
    if (queryType === 'research' && result.task_output && result.task_output.length > 1) {
      extractedContent = `📚 **Research Summary** 📚\n${cleanMarkdown(result.task_output[0].result)}\n\n🔍 **Key Insights:**\n${cleanMarkdown(result.task_output[1].result)}`;
    } else if (queryType === 'blog' && result.task_output && result.task_output.length > 1) {
      extractedContent = `📝 **Blog Post** 📝\n${cleanMarkdown(result.task_output[1].result)}`;
    } else if (queryType === 'twitter' && result.task_output && result.task_output.length > 2) {
      extractedContent = `🐦 **Twitter Thread** 🐦\n${cleanMarkdown(result.task_output[2].result)}`;
    } else if (result.result) {
      extractedContent = `ℹ️ **Task Results** ℹ️\n${cleanMarkdown(result.result)}`;
    } else if (result.task_output && result.task_output.length > 0) {
      // Fallback to first task output if result is empty
      extractedContent = `ℹ️ **Task Results** ℹ️\n${cleanMarkdown(result.task_output[0].result)}`;
    } else {
      extractedContent = "No results data found in the response.";
    }
  } catch (error) {
    console.error('Error extracting data:', error);
    extractedContent = "Error processing the result data. Please check the console logs.";
  }

  return extractedContent;
}

function cleanMarkdown(text: string): string {
  if (!text) return '';
  
  return text
    .replace(/##/g, '**')
    .replace(/\*\*/g, '')
    .replace(/```/g, '')
    .replace(/\[.*?\]\(.*?\)/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

async function callCustomAPI(message: Message) {
  try {
    const basePayload: Payload = {
      webhook: WEBHOOK_URL
    };

    const dynamicPayload = parseArguments(message.content);
    const finalPayload: Payload = { ...basePayload, ...dynamicPayload };

    console.log(`Sending API request to: ${process.env.API_ENDPOINT}`);
    console.log(`With payload:`, JSON.stringify(finalPayload, null, 2));
    
    const response = await axios.post(process.env.API_ENDPOINT!, finalPayload);
    
    console.log(`API Response Status: ${response.status}`);
    console.log(`API Response:`, JSON.stringify(response.data, null, 2));
    
    return response.data;
  } catch (error) {
    console.error('API call failed:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    throw error;
  }
}

function parseArguments(content: string): Partial<Payload> {
  // Extract everything after !runcrew as the query
  const fullCommand = content.trim();
  const queryStart = fullCommand.indexOf(' ');
  
  if (queryStart === -1) {
    return {}; // No arguments provided
  }
  
  const query = fullCommand.substring(queryStart + 1).trim();
  
  return {
    query_post: query  // This will be the actual query text
  };
}

// Start the bot
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('Bot logged in successfully'))
  .catch(error => console.error('Failed to login:', error));