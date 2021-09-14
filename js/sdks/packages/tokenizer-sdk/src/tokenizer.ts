import { OutgoingHttpHeaders } from 'http';

import { LunaSecError } from '@lunasec/isomorphic-common';
import { AxiosError } from 'axios';

import { downloadFromS3WithSignedUrl, uploadToS3WithSignedUrl } from './aws';
import { AUTHORIZATION_HEADER, CONFIG_DEFAULTS, SESSION_HASH_HEADER } from './constants';
import { Configuration, DefaultApi, ErrorResponse, MetaData } from './generated';
import {
  SuccessOrFailOutput,
  TokenizerClientConfig,
  TokenizerDetokenizeResponse,
  TokenizerDetokenizeToUrlResponse,
  TokenizerFailApiResponse,
  TokenizerGetMetadataResponse,
  TokenizerTokenizeResponse,
} from './types';

// Uses an openAPI generated client to query the tokenizer.  The biggest gotchas here are that:
// 1) Axios returns an res object with the tokenizer's response on the 'data' property, but the tokenizer also wraps its responses with 'data'
// So the actual response body is res.data.data.  We handle that here
// 2) Axios throws for any non 200 response code, and then we lose the typing of the error response, so we catch and then stick it back on.

export class Tokenizer {
  readonly config!: TokenizerClientConfig;
  readonly openApi: DefaultApi;
  private reqOptions: Record<string, any>;

  constructor(config?: Partial<TokenizerClientConfig>) {
    // Deep clone config for mutation safety.
    this.config = JSON.parse(JSON.stringify(Object.assign({}, CONFIG_DEFAULTS, config)));

    const headers: OutgoingHttpHeaders = {
      'Content-Type': 'application/json',
    };
    const jwtToken = this.config.authenticationToken;
    if (jwtToken) {
      headers[AUTHORIZATION_HEADER] = jwtToken;
    }
    this.reqOptions = { headers }; // This is passed to the openapi client on every request

    const basePath = this.getBasePath();

    // openapi stuff
    const openAPIConfig = new Configuration({ basePath });
    this.openApi = new DefaultApi(openAPIConfig);
  }

  // the session hash for an iFrame binds the iFrame to a specific session, and will prevent
  // "grant jacking" attempts where an attacker is able to log someone out and log them into the
  // attacker's account. This would let an attacker be able to tokenize already detokenized data
  // which would let the attacker view the plaintext by subsequently detokenized this newly created
  // token with the victim's plaintext.
  private setSessionHash(sessionHash: string) {
    this.reqOptions = {
      ...this.reqOptions,
      [SESSION_HASH_HEADER]: sessionHash,
    };
  }

  private getBasePath(): string {
    if (this.config.baseRoute !== '') {
      return new URL(this.config.baseRoute, this.config.host).toString();
    }
    return new URL(this.config.host).origin;
  }

  private handleError(e: AxiosError | Error | any): TokenizerFailApiResponse {
    return {
      success: false,
      error: this.constructError(e),
    };
  }

  private constructError(e: AxiosError<ErrorResponse> | Error | any) {
    if ('response' in e && e.response) {
      // Parse the axios error, if it has any meaningful data about the response
      return new LunaSecError({
        name: e.response.data.error.name || 'unknownTokenizerError',
        message: e.response.data.error.message || 'Unknown Tokenizer Error',
        code: e.response.status.toString(),
      });
    }
    if (e instanceof Error) {
      return new LunaSecError(e); // This can handle axios errors where we dont even get a response, or any other case
    }
    return new LunaSecError({ name: 'unknownTokenizerError', message: 'Unknown Tokenization Error', code: '500' });
  }

  public async createFullAccessGrant(sessionId: string, tokenId: string) {
    try {
      const res = await this.openApi.setGrant(
        {
          sessionId,
          tokenId,
        },
        this.reqOptions
      );
      return {
        success: res.data.success,
      };
    } catch (e) {
      return this.handleError(e);
    }
  }

  async verifyGrant(sessionId: string, tokenId: string) {
    try {
      const res = await this.openApi.verifyGrant(
        {
          sessionId,
          tokenId,
        },
        this.reqOptions
      );
      return {
        success: true,
        valid: res.data.data.valid,
      };
    } catch (e) {
      return this.handleError(e);
    }
  }

  async getMetadata(tokenId: string): SuccessOrFailOutput<TokenizerGetMetadataResponse> {
    try {
      const res = await this.openApi.getMetaData(
        {
          tokenId,
        },
        this.reqOptions
      );
      return {
        success: true,
        metadata: res.data.data.metadata,
        tokenId: tokenId, // Not sure why we pass this back, seems useless in this context
      };
    } catch (e) {
      return this.handleError(e);
    }
  }

  async tokenize(input: string | Buffer, metadata: MetaData): SuccessOrFailOutput<TokenizerTokenizeResponse> {
    try {
      const res = await this.openApi.tokenize(
        {
          metadata,
        },
        this.reqOptions
      );
      const data = res.data.data;
      await uploadToS3WithSignedUrl(data.uploadUrl, data.headers as OutgoingHttpHeaders, input);

      return {
        success: true,
        tokenId: data.tokenId,
      };
    } catch (e) {
      console.error(e);
      return this.handleError(e);
    }
  }

  async detokenize(tokenId: string): SuccessOrFailOutput<TokenizerDetokenizeResponse> {
    const response = await this.detokenizeToUrl(tokenId);

    if (!response.success) {
      return response;
    }
    const { headers, downloadUrl } = response;
    return {
      success: true,
      tokenId: tokenId,
      value: await downloadFromS3WithSignedUrl(downloadUrl, headers),
    };
  }

  async detokenizeToUrl(tokenId: string): SuccessOrFailOutput<TokenizerDetokenizeToUrlResponse> {
    try {
      const response = await this.openApi.detokenize(
        {
          tokenId,
        },
        this.reqOptions
      );
      const res = response.data;

      console.log(response.headers);

      const sessionHash = response.headers[SESSION_HASH_HEADER];
      if (sessionHash === undefined) {
        return {
          success: false,
          error: new LunaSecError({
            name: 'detokenizationiFrameSessionBinding',
            message: 'session hash was not set in response when detokenizing, unable to bind iFrame to a session',
            code: '500',
          }),
        };
      }
      this.setSessionHash(sessionHash);

      if (!res.data) {
        return {
          success: false,
          error: new LunaSecError({
            name: 'badDetokenizeResponse',
            message: 'Invalid response from Tokenizer when detokenizing data',
            code: '500',
          }),
        };
      }

      const { downloadUrl, headers } = res.data;
      return {
        success: true,
        tokenId: tokenId,
        headers: headers,
        downloadUrl: downloadUrl,
      };
    } catch (e) {
      return this.handleError(e);
    }
  }
}
