; AMI for the Rasa backend only (written at container start). Port 5038 is never published: it is reachable only on
; the internal Docker network pbx-net, and only from PBX_AMI_PERMIT.
[general]
enabled=yes
port=5038
bindaddr=0.0.0.0
displayconnects=no
allowmultiplelogin=no
authtimeout=10
authlimit=5

[@AMI_USER@]
secret=@AMI_SECRET@
deny=0.0.0.0/0.0.0.0
permit=@AMI_PERMIT@
; call/system events; write: originate (click-to-call), system (reload of res_pjsip / pbx_config, PJSIPShowEndpoint).
; No "command" (CLI) or "config" (editing files through AMI) rights.
read=call,system
write=originate,system
writetimeout=5000
