/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

const headerSize = 44;
const sampleRate = 16000;
const bytesPerSample = 2;
const channels = 1;

/**
 * Associate bindings declared in wrangler.toml with the TypeScript type system
 */
export interface Env {
    AI: any;
}

import {Ai} from '@cloudflare/ai'

const audio = `
class Processor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.length = 0;
    }

    // 1-channel audio should be enough to have some fun.
    process([input], [output]) {
        if (this.length === 0) {
            this.port.postMessage({
                type: 'start'
            });
        }
    
        this.length += input[0].length;
    
        const data = Int16Array.from(input[0], n => {
            const res = n < 0 ? n * 0x8000 : n * 0x7FFF
            return Math.max(-0x8000, Math.min(0x7FFF, res))
        })
    
        this.port.postMessage({
            type: 'data',
            audioBuffer: data
        });
    
        return true;
    }
}

registerProcessor("processor", Processor);
`

const html = `
<html>
	<head>
	    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous">
	</head>
	<body>
	    <div class="container">
            <div class="row align-items-md-stretch">
                <div class="col-xs-12 col-lg-12 col-md-12 py-4">
                    <div class="h-100 p-5 bg-body-tertiary border rounded-3">
                        <h2>Microphone-Speech-To-Text</h2>
                        <p>
                            Hit the button below to record some audio from your microphone.</br>
                            Once finished, hit the button again to send the recording to Cloudflare Workers AI. </br>
                            </br>
                            <code>@cf/openai/whisper</code> will convert your speech-to-text.</br>
                            <code>@cf/mistral/mistral-7b-instruct-v0.1</code> will respond if you ask for something nice. </br>
                            </br>
                            <b>This site needs access to your microphone. Your audio data will be converted to a WAVE PCM file within a Cloudflare Worker and is only used for speech-to-text recognition. No audio data will be stored.</b></br>
                            </br>
                            <a style = "color: #d63384;" href = "https://github.com/cehrig/workers-ai-microphone-speech-to-text/tree/main">Source on GitHub</a>  
                        </p>
                        <div class = "row">
                            <div class = "col-5" id="request" style = "color: #d63384; font-size: 20px"></div>
                            <div class = "col-2"></div>
                            <div class = "col-5" id="response" style = "color: #d63384; font-size: 20px"></div>
                        </div>
                        <div class = "text-center pt-5">
                            <button type="button" class="btn btn-lg btn-outline-danger" id = "record" onclick="trigger()">
                                Start Recording
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
	</body>
	<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz" crossorigin="anonymous"></script>
	<script src="https://unpkg.com/typewriter-effect@latest/dist/core.js"></script>
	<script>
        let context = null;
        let socket = null;
        let connected = false;
        let stream = null;
        let recording = false;
        
        const request = document.getElementById("request");
        const response = document.getElementById("response");
        
        const request_writer = init_typewriter(request);
        let response_writer = null;
        
        function init_typewriter(elem) {
            return new Typewriter(elem, {
                loop: false,
                delay: 10,
            });
        }
        
        // Start microphone
        async function stream_start() {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
            });
        }
        
        // Stop microphone
        async function stream_end() {
            if (stream !== null) {
                stream.getTracks().forEach( track => track.stop() );
            }
        }
        
        // Make sure we ask user for microphone permission but stop the stream immediately
        async function consent() {
            await stream_start();
            await stream_end();
        }
        
        async function trigger() {
            if (recording === false) {
                await start();
            } else {
                await stop();
            }
        }
        
        function button() {
            const button = document.getElementById('record');
            
            if (recording === false) {
                button.innerHTML = 'Start Recording';
                button.classList.remove('btn-danger');
                button.classList.add('btn-outline-danger');
            } else {
                button.innerHTML = 'End Recording';
                button.classList.remove('btn-outline-danger');
                button.classList.add('btn-danger');
            }
        }

        // Starts a new recording
        async function start() {
            recording = true;
            button();
            await stream_start();

            // We don't have access to the microphone
            if (stream === null) {
                await stop();
                return;
            }
            
            // Create new AudioContext and process data in Audio rendering thread
            context = new AudioContext({
                sampleRate: ${sampleRate},
            });
  
            const source = context.createMediaStreamSource(stream);
            await context.audioWorklet.addModule("audio.js");
            const processor = new AudioWorkletNode(context, "processor");
            source.connect(processor);
  
            // We will consume messages from the processor here
            processor.port.onmessage = async (e) => {
                // If we are not connected to the websocket we can immediately stop recording
                if (!connected) {
                    await stop();
                }
      
                // If this is the first set of samples, we will notify the websocket server to start capturing a
                // new WAVE file
                if (e.data.type === 'start') {
                    socket.send('start');
                }
      
                // Stream audio samples
                if (e.data.type === 'data') {
                    socket.send(e.data.audioBuffer);
                }
            };
        }

        // Stops a recording
        async function stop() {
            recording = false;
            button();

            // By sending an end-frame to the websocket server, indicating that it can start creating the WAVE file
            if (socket !== null) {
                socket.send("end");
            }

            if (context === null) {
                return;
            }
            
            // We close the microphone and audio context
            await stream_end();
            await context.close();

            context = null;
        }

        // Connects to our Worker over websockets
        function websocket() {
            let ws = new URL(window.location);
            ws.protocol = (ws.protocol === "https:") ? "wss" : "ws";
            ws.pathname = 'ws';

            socket = new WebSocket(ws);
            
            const reconnect = function () {
                socket = null;
                connected = false;
                setTimeout(websocket, 2000);
            }

            socket.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    
                    if (message.ctx === 'request') {
                        request_writer.deleteAll(1).pauseFor(50).typeString(message.text).start();
                        response_writer = init_typewriter(response);
                    } else {
                        response_writer.deleteAll(2).typeString(message.text).start();
                    }
                } catch(ex) {
                    output.innerHTML += "<Error reading model response> </br>";
                }
            };
            
            socket.onopen = (e) => {
                console.log('connected', e);
                connected = true;
            };

            socket.onclose = (e) => {
                console.log('closed', e);
                reconnect();
            }

            socket.onerror = (e) => {
                console.log('error', e);
                socket.close();
            }
        }
        
        websocket();
    </script>	
</html>
`

export default {
    /**
     * This is the standard fetch handler for a Cloudflare Worker
     *
     * @param request - The request submitted to the Worker from the client
     * @param env - The interface to reference bindings declared in wrangler.toml
     * @param ctx - The execution context of the Worker
     * @returns The response to be sent back to the client
     */
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        let url = new URL(request.url);
        const upgrade = request.headers.get('upgrade') || '';

        // Websocket requests
        if (upgrade === 'websocket') {
            const webSocketPair = new WebSocketPair();
            const [client, server] = [webSocketPair[0], webSocketPair[1]];

            await this.websocket(server, env);

            return new Response(null, {
                status: 101,
                webSocket: client,
            });
        }

        // Audio processor requests javascript modules from here
        if (url.pathname === '/audio.js') {
            return new Response(`${audio}`, {
                headers: {
                    'content-type': 'application/javascript'
                }
            });
        }

        // Our frontend
        return new Response(`${html}`, {
            headers: {
                'content-type': 'text/html'
            }
        });
    },

    async websocket(socket: WebSocket, env: Env) {
        let wave: Wave;

        socket.accept();
        socket.addEventListener('message', async event => {
            try {
                switch (event.data) {
                    case 'start':
                        wave = new Wave();
                        break;
                    case 'end':
                        const listen = await this.listen(wave.file(), env);
                        socket.send(JSON.stringify({ctx: 'request', text: listen.text}));

                        const response = await this.respond(listen.text, env);
                        socket.send(JSON.stringify({ctx: 'response', text: response.response}));
                        break;
                    default:
                        if (event.data instanceof ArrayBuffer) {
                            wave.add(event.data);
                        }
                }
            } catch (ex) {
                socket.close();
            }
        });
    },

    async listen(wave: Uint8Array, env: Env) {
        const ai = new Ai(env.AI);
        const inputs = {
            audio: [...wave],
        };

        return await ai.run("@cf/openai/whisper", inputs);
    },

    async respond(input: string, env: Env) {
        const ai = new Ai(env.AI);
        const messages = [
            {
                role: "user",
                content: input,
            },
        ];

        return await ai.run("@cf/mistral/mistral-7b-instruct-v0.1", {messages});
    }
};

class Wave {
    bytes: Uint8Array
    length: number

    constructor() {
        this.bytes = new Uint8Array();
        this.length = 0;
    }

    add(buffer: ArrayBuffer) {
        const add = new Uint8Array(buffer);

        let bytes = new Uint8Array(this.length + add.length);
        bytes.set(this.bytes);
        bytes.set(add, this.length);

        this.length += add.length;
        this.bytes = bytes;
    }

    file() {
        const buffer = new ArrayBuffer(headerSize);
        const header = new DataView(buffer);

        // RIFF
        header.setUint8(0, 0x52);
        header.setUint8(1, 0x49);
        header.setUint8(2, 0x46);
        header.setUint8(3, 0x46);

        // ChunkSize
        header.setUint32(4, 36 + this.length, true);

        // WAVE
        header.setUint8(8, 0x57);
        header.setUint8(9, 0x41);
        header.setUint8(10, 0x56);
        header.setUint8(11, 0x45);

        // Subchunk ID
        header.setUint8(12, 0x66);
        header.setUint8(13, 0x6D);
        header.setUint8(14, 0x74);
        header.setUint8(15, 0x20);

        // Subchunk Size
        header.setUint32(16, 16, true);

        // AudioFormat
        header.setUint16(20, 1, true);

        // Number of channels
        header.setUint16(22, channels, true);

        // SampleRate
        header.setUint32(24, sampleRate, true);

        // ByteRate
        header.setUint32(28, sampleRate * bytesPerSample * channels, true);

        // BlockAlign
        header.setUint16(32, bytesPerSample * channels, true);

        // BitsPerSample
        header.setUint16(34, 8 * bytesPerSample, true);

        // Subchunk ID
        header.setUint8(36, 0x64);
        header.setUint8(37, 0x61);
        header.setUint8(38, 0x74);
        header.setUint8(39, 0x61);

        // Subchunk Size
        header.setUint32(40, this.length, true);

        // Combined Header + Audio
        let combined = new Uint8Array(headerSize + this.length);
        combined.set(new Uint8Array(buffer));
        combined.set(this.bytes, headerSize);

        return combined
    }
}
