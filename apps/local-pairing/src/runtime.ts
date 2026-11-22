import type { Logger } from "@openbot/logging";
import { Effect } from "effect";
import type { LocalPairingConfig } from "./config";
import { createLocalPairingHandler } from "./http";
import { LocalPairingService } from "./service";
import { StateStore } from "./state";
import { createTicketSigner } from "./tickets";

export interface LocalPairingRuntime {
  config: LocalPairingConfig;
  service: LocalPairingService;
  handle(request: Request): Promise<Response>;
}

export async function createLocalPairingRuntime(
  config: LocalPairingConfig,
  logger: Logger,
): Promise<LocalPairingRuntime> {
  const store = await Effect.runPromise(StateStore.load(config.statePath));
  const snapshot = store.snapshot();
  if (!snapshot.user) {
    const user = {
      id: config.userId,
      email: config.email,
      name: config.name,
      avatarUrl: null,
      analyticsEnabled: null,
    };
    await Effect.runPromise(
      store.update((state) => {
        state.user = user;
      }),
    );
  }
  const { signer, created } = await createTicketSigner(snapshot.ticketKey);
  if (created) {
    const key = created;
    await Effect.runPromise(
      store.update((state) => {
        state.ticketKey ??= key;
      }),
    );
  }
  const service = new LocalPairingService(config, store, signer);
  return { config, service, handle: createLocalPairingHandler({ config, service, logger }) };
}
