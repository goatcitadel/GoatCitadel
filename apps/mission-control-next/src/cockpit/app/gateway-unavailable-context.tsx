import { createContext, useContext } from "react";

/**
 * True while the shell's connection check says GoatCitadel cannot be reached. The shell already announces this in its
 * connection banner; areas that must not send a decision meanwhile read it here instead of probing a second time.
 */
export const GatewayUnavailableContext = createContext(false);

export const useGatewayUnavailable = (): boolean => useContext(GatewayUnavailableContext);
