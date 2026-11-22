import type { WebSocket } from "ws";
import type { RpcMethod, RpcMethods } from "../shared/protocol";

export type Handlers = { [M in RpcMethod]: (params: RpcMethods[M]["params"], client: WebSocket) => Promise<RpcMethods[M]["result"]> | RpcMethods[M]["result"] };

export type HandlersFor<M extends RpcMethod> = Pick<Handlers, M>;

export type MethodsIn<Prefix extends string> = Extract<RpcMethod, `${Prefix}.${string}`>;
