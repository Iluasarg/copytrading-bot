import { Idl } from "@coral-xyz/anchor";
import idlJson from "./pumpswap.json";

// Определяем типы, соответствующие IdlType
type CustomIdlType =
    | "publicKey"
    | { array: [CustomIdlType, number] };

// Определяем тип для полей структуры
interface CustomIdlField {
    name: string;
    type: CustomIdlType;
}

// Определяем основной тип для IDL
interface CustomIdl {
    version: string;
    name: string;
    instructions: any[];
    accounts: Array<{
        name: string;
        type: {
            kind: "struct";
            fields: CustomIdlField[];
        };
    }>;
    types: any[];
    events: any[];
    errors: any[];
}

const customIdlJson = idlJson as CustomIdl;

const adaptedIdl: Idl = {
    version: customIdlJson.version || "0.1.0",
    name: customIdlJson.name || "pumpswap",
    instructions: customIdlJson.instructions || [],
    accounts: customIdlJson.accounts || [],
    types: customIdlJson.types || [],
    events: customIdlJson.events || [],
    errors: customIdlJson.errors || [],
};

export const IDL: Idl = adaptedIdl;