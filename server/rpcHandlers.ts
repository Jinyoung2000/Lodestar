import type { WebSocket } from "ws";
import type { RpcMethod, RpcMethods } from "../shared/protocol";

// client 는 요청을 보낸 연결이다. 공유 목록과 도구 결과처럼 어느 화면이 보냈는지가 중요한 요청만 쓴다.
export type Handlers = { [M in RpcMethod]: (params: RpcMethods[M]["params"], client: WebSocket) => Promise<RpcMethods[M]["result"]> | RpcMethods[M]["result"] };

export type HandlersFor<M extends RpcMethod> = Pick<Handlers, M>;

export type MethodsIn<Prefix extends string> = Extract<RpcMethod, `${Prefix}.${string}`>;
