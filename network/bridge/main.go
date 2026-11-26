package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"unsafe"

	"twindesk.local/embedded/engine"
)

const invalidRequest = `{"ok":false,"error":"invalid-request"}`

//export twindesk_net_call
func twindesk_net_call(request *C.char) *C.char {
	if request == nil {
		return C.CString(invalidRequest)
	}
	return C.CString(engine.Call(C.GoString(request)))
}

//export twindesk_net_free
func twindesk_net_free(reply *C.char) {
	C.free(unsafe.Pointer(reply))
}

func main() {}
