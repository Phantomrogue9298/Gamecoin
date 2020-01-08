import { P2P } from "@arkecosystem/core-interfaces";
import Ajv from "ajv";
import { cidr } from "ip";
import SCWorker from "socketcluster/scworker";
import { requestSchemas } from "../schemas";
import { codec } from "../utils/sc-codec";

const MINUTE_IN_MILLISECONDS = 1000 * 60;
const HOUR_IN_MILLISECONDS = MINUTE_IN_MILLISECONDS * 60;

const ajv = new Ajv({ extendRefs: true });

export class Worker extends SCWorker {
    private config: Record<string, any>;
    private handlers: string[] = [];
    private ipLastError: Record<string, number> = {};

    public async run() {
        this.log(`Socket worker started, PID: ${process.pid}`);

        this.scServer.setCodecEngine(codec);

        await this.loadConfiguration();

        // purge ipLastError every hour to free up memory
        setInterval(() => (this.ipLastError = {}), HOUR_IN_MILLISECONDS);

        await this.loadHandlers();

        // @ts-ignore
        this.scServer.wsServer.on("connection", (ws, req) => {
            this.handlePayload(ws, req);
        });
        this.scServer.on("connection", socket => this.handleConnection(socket));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_HANDSHAKE_WS, (req, next) =>
            this.handleHandshake(req, next),
        );
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_EMIT, (req, next) => this.handleEmit(req, next));
    }

    private async loadHandlers(): Promise<void> {
        const { data } = await this.sendToMasterAsync("p2p.utils.getHandlers");
        for (const [version, handlers] of Object.entries(data)) {
            for (const handler of Object.values(handlers)) {
                this.handlers.push(`p2p.${version}.${handler}`);
            }
        }
    }

    private async loadConfiguration(): Promise<void> {
        const { data } = await this.sendToMasterAsync("p2p.utils.getConfig");
        this.config = data;
    }

    private handlePayload(ws, req) {
        ws.prependListener("ping", () => {
            this.setErrorForIpAndTerminate(ws, req);
        });
        ws.prependListener("pong", () => {
            this.setErrorForIpAndTerminate(ws, req);
        });
        ws.prependListener("message", message => {
            if (ws._disconnected) {
                this.setErrorForIpAndTerminate(ws, req);
            } else if (message === "#2") {
                const timeNow: number = new Date().getTime() / 1000;
                if (ws._lastPingTime && timeNow - ws._lastPingTime < 1) {
                    this.setErrorForIpAndTerminate(ws, req);
                }
                ws._lastPingTime = timeNow;
            } else if (message.length < 10) {
                // except for #2 message, we should have JSON with some required properties
                // (see below) which implies that message length should be longer than 10 chars
                this.setErrorForIpAndTerminate(ws, req);
            } else {
                try {
                    const parsed = JSON.parse(message);
                    if (parsed.event === "#disconnect") {
                        ws._disconnected = true;
                    } else if (parsed.event === "#handshake") {
                        if (ws._handshake) {
                            this.setErrorForIpAndTerminate(ws, req);
                        }
                        ws._handshake = true;
                    } else if (
                        typeof parsed.event !== "string" ||
                        typeof parsed.data !== "object" ||
                        this.hasAdditionalProperties(parsed) ||
                        (typeof parsed.cid !== "number" &&
                            (parsed.event === "#disconnect" && typeof parsed.cid !== "undefined")) ||
                        !this.handlers.includes(parsed.event)
                    ) {
                        this.setErrorForIpAndTerminate(ws, req);
                    }
                } catch (error) {
                    this.setErrorForIpAndTerminate(ws, req);
                }
            }
        });
    }

    private hasAdditionalProperties(object): boolean {
        if (Object.keys(object).filter(key => key !== "event" && key !== "data" && key !== "cid").length) {
            return true;
        }
        const event = object.event.split(".");
        if (object.event !== "#handshake" && object.event !== "#disconnect") {
            if (event.length !== 3) {
                return true;
            }
            if (Object.keys(object.data).filter(key => key !== "data" && key !== "headers").length) {
                return true;
            }
        }
        if (object.data.data) {
            // @ts-ignore
            const [_, version, handler] = event;
            const schema = requestSchemas[version][handler];
            try {
                if (schema && !ajv.validate(schema, object.data.data)) {
                    return true;
                }
            } catch {
                //
            }
        }
        if (object.data.headers) {
            if (
                Object.keys(object.data.headers).filter(
                    key => key !== "version" && key !== "port" && key !== "height" && key !== "Content-Type",
                ).length
            ) {
                return true;
            }
            if (
                (object.data.headers.version && typeof object.data.headers.version !== "string") ||
                (object.data.headers.port && typeof object.data.headers.port !== "number") ||
                (object.data.headers["Content-Type"] && typeof object.data.headers["Content-Type"] !== "string") ||
                (object.data.headers.height && typeof object.data.headers.height !== "number")
            ) {
                // this prevents the nesting of other objects inside these properties
                return true;
            }
        }
        return false;
    }

    private setErrorForIpAndTerminate(ws, req): void {
        this.ipLastError[req.socket.remoteAddress] = Date.now();
        ws.terminate();
    }

    private async handleConnection(socket): Promise<void> {
        for (const handler of this.handlers) {
            // @ts-ignore
            socket.on(handler, async (data, res) => {
                try {
                    return res(undefined, await this.sendToMasterAsync(handler, data));
                } catch (e) {
                    return res(e);
                }
            });
        }
    }

    private async handleHandshake(req, next): Promise<void> {
        const ip = req.socket.remoteAddress;
        if (this.ipLastError[ip] && this.ipLastError[ip] > Date.now() - MINUTE_IN_MILLISECONDS) {
            req.socket.destroy();
            return;
        }

        const { data }: { data: { blocked: boolean } } = await this.sendToMasterAsync(
            "p2p.internal.isBlockedByRateLimit",
            {
                data: { ip },
            },
        );

        const isBlacklisted: boolean = (this.config.blacklist || []).includes(ip);
        if (data.blocked || isBlacklisted) {
            req.socket.destroy();
            return;
        }

        const cidrRemoteAddress = cidr(`${ip}/24`);
        const sameSubnetSockets = Object.values({ ...this.scServer.clients, ...this.scServer.pendingClients }).filter(
            client => cidr(`${client.remoteAddress}/24`) === cidrRemoteAddress,
        );
        if (sameSubnetSockets.length > this.config.maxSameSubnetPeers) {
            req.socket.destroy();
            return;
        }

        next();
    }

    private async handleEmit(req, next): Promise<void> {
        if (req.event.length > 128) {
            req.socket.terminate();
            return;
        }

        const { data }: { data: P2P.IRateLimitStatus } = await this.sendToMasterAsync(
            "p2p.internal.getRateLimitStatus",
            {
                data: {
                    ip: req.socket.remoteAddress,
                    endpoint: req.event,
                },
            },
        );

        if (data.exceededLimitOnEndpoint) {
            req.socket.terminate();
            return;
        }

        // ensure basic format of incoming data, req.data must be as { data, headers }
        if (typeof req.data !== "object" || typeof req.data.data !== "object" || typeof req.data.headers !== "object") {
            req.socket.terminate();
            return;
        }

        try {
            const [prefix, version, handler] = req.event.split(".");

            if (prefix !== "p2p") {
                req.socket.terminate();
                return;
            }

            // Check that blockchain, tx-pool and p2p are ready
            const isAppReady: boolean = (await this.sendToMasterAsync("p2p.utils.isAppReady")).data.ready;
            if (!isAppReady) {
                next(new Error("App is not ready."));
                return;
            }

            if (version === "internal") {
                const { data } = await this.sendToMasterAsync("p2p.utils.isForgerAuthorized", {
                    data: { ip: req.socket.remoteAddress },
                });

                if (!data.authorized) {
                    req.socket.terminate();
                    return;
                }
            } else if (version === "peer") {
                const requestSchema = requestSchemas.peer[handler];
                if (["postTransactions", "postBlock"].includes(handler)) {
                    // has to be in the peer list to use the endpoint
                    const {
                        data: { isPeerOrForger },
                    } = await this.sendToMasterAsync("p2p.internal.isPeerOrForger", {
                        data: { ip: req.socket.remoteAddress },
                    });
                    if (!isPeerOrForger) {
                        req.socket.terminate();
                        return;
                    }
                } else if (requestSchema && !ajv.validate(requestSchema, req.data.data)) {
                    req.socket.terminate();
                    return;
                }

                this.sendToMasterAsync("p2p.internal.acceptNewPeer", {
                    data: { ip: req.socket.remoteAddress },
                    headers: req.data.headers,
                }).catch(ex => {
                    this.log(`Failed to accept new peer ${req.socket.remoteAddress}: ${ex.message}`, "debug");
                });
            } else {
                req.socket.terminate();
                return;
            }

            // some handlers need this remoteAddress info
            // req.data is socketcluster request data, which corresponds to our own "request" object
            // which is like this { endpoint, data, headers }
            req.data.headers.remoteAddress = req.socket.remoteAddress;
        } catch (e) {
            this.log(e.message, "error");

            req.socket.terminate();
            return;
        }

        next();
    }

    private async log(message: string, level: string = "info"): Promise<void> {
        try {
            await this.sendToMasterAsync("p2p.utils.log", {
                data: { level, message },
            });
        } catch (e) {
            console.error(`Error while trying to log the following message: ${message}`);
        }
    }

    private async sendToMasterAsync(endpoint: string, data?: Record<string, any>): Promise<any> {
        return new Promise((resolve, reject) => {
            this.sendToMaster(
                {
                    ...{ endpoint },
                    ...data,
                },
                (err, res) => (err ? reject(err) : resolve(res)),
            );
        });
    }
}

// tslint:disable-next-line
new Worker();
