#ifndef APPSHARE_NETWORK_H
#define APPSHARE_NETWORK_H

char *twindesk_net_call(const char *request);
void twindesk_net_free(char *reply);

#endif
