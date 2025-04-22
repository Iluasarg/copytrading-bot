import Long from "long";
import _m0 from "protobufjs/minimal";

export const protobufPackage = "shared";

export interface Timestamp {
    seconds: number;
    nanos: number;
}

export const Timestamp = {
    encode(message: Timestamp, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.seconds !== 0) {
            writer.uint32(8).int64(message.seconds);
        }
        if (message.nanos !== 0) {
            writer.uint32(16).int32(message.nanos);
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): Timestamp {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = { seconds: 0, nanos: 0 };
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.seconds = longToNumber(reader.int64() as Long);
                    break;
                case 2:
                    message.nanos = reader.int32();
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): Timestamp {
        return {
            seconds: isSet(object.seconds) ? Number(object.seconds) : 0,
            nanos: isSet(object.nanos) ? Number(object.nanos) : 0,
        };
    },

    toJSON(message: Timestamp): unknown {
        const obj: any = {};
        message.seconds !== undefined && (obj.seconds = Math.round(message.seconds));
        message.nanos !== undefined && (obj.nanos = message.nanos);
        return obj;
    },
};

function longToNumber(long: Long): number {
    if (long.gt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Value is larger than Number.MAX_SAFE_INTEGER");
    }
    return long.toNumber();
}

function isSet(value: any): boolean {
    return value !== null && value !== undefined;
}