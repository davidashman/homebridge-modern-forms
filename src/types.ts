
export declare type ResponsePayload = {
  fanOn: boolean,
  fanSpeed: number,
  fanDirection: 'forward' | 'reverse',
  lightOn: boolean,
  lightBrightness: number,
  clientId: string
}

export type RequestPayload = Omit<Partial<ResponsePayload>, 'clientId'>
