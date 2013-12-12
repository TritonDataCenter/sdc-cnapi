# NAME

CNAPI Waitlist

# SYNOPSIS

    GET /servers/:server_uuid/waitlist
    GET /servers/:server_uuid/waitlist/:ticket_id
    GET /servers/:server_uuid/waitlist/:ticket_id&wait=true
    POST /servers/:server_uuid/waitlist
    DELETE /servers/:server_uuid/waitlist/:ticket_id


# DESCRIPTION

Serialize work on a server via a waitlist to prevent multiple clients from
performing simultaneous operations on a server resource, such as a vm or
dataset.

Acquiring a ticket before performing work is an explicit step, as opposed to
CNAPI doing the serialization on its own in an effort to add transparency and
to know what is happening with the SDC pipeline from just looking at the
top-level workflow for some work to be performed.

Clients will acquire a waitlist "ticket" and then either poll the status of the
given ticket or simply connect and block until our given ticket comes up for
fulfillment.

Waitlist tickets are implicitly serialized down by server uuid, and explicitly
through scope and id. The scope allows us to "lock" different server resources
without them clashing. For example issuing a request for a ticket with
`scope=vm` or `scope=dataset`, and passing in a `id` parameter.

This system is purely opt-in, leaving the option of manual intervention
available. It is up to the client or requester to "opt-in" to this system. Not
taking advantage of the system may result in undefined behaviour.


# ENDPOINTS

### Request (create) a ticket

Using the waitlist begins with requesting a ticket. POST to the
CreateWaitlistTicket endpoint. Specify the scope and unique id. An expiry date
may also be specified for when the ticket should expire and no longer be
considered active. Endpoint returns a ticket uuid.

    sdc-cnapi -X POST \
        /servers/42e66c8e-3fc6-11e3-a7cb-eb7cef96d803/waitlist -d '{ \
        "scope": "vm", "uid": "2583dc4e-3fc1-11e3-ac53-4b10c1f49ef6",
        "expires": "2013-10-10T00:00:00" }'

    >>>

    200 OK
    { "ticket_uuid": "c6e36736-3fc5-11e3-ad45-4ff5aeba4d70" }
    

### Display all tickets

    sdc-cnapi -X GET \
        /servers/42e66c8e-3fc6-11e3-a7cb-eb7cef96d803/waitlist

    >>>

    200 OK
    [
        {
            "ticket_uuid": "c6e36736-3fc5-11e3-ad45-4ff5aeba4d70"
            "created_at": "2013-10-28T11:46:01.321Z",
            "server_uuid": "42e66c8e-3fc6-11e3-a7cb-eb7cef96d803"
            "scope": "vm",
            "id": "b12d667a-3fc6-11e3-859b-c3785420ad84"
        },
        {
            "ticket_uuid": "be983b14-400c-11e3-bf4c-3f635a0d9ff3"
            "created_at": "2013-10-28T11:46:01.321Z",
            "server_uuid": "42e66c8e-3fc6-11e3-a7cb-eb7cef96d803"
            "scope": "dataset",
            "id": "7a61f81c-3fc7-11e3-b0ed-83ee11549449"
        }
    ]


### Delete a ticket

Explicitly deletes a waitlist ticket. This will allow the next ticket in line
for the given scope/id to proceed. The next ticket waiting on the same scope/id
will be allowed to proceed.

    sdc-cnapi -X DELETE 
        /servers/:uuid/waitlist/c6e36736-3fc5-11e3-ad45-4ff5aeba4d70

    >>>

    202 OK
    

## Display all tickets for a given scope and id

Returns all active tickets.

    # Display all waitlist for scope 'vm' and given uuid
    sdc-cnapi -X GET
        /servers/:uuid/waitlist?scope=vm&id=2583dc4e-3fc1-11e3-ac53-4b10c1f49ef6

    >>>

    200 OK
    [
        {
            "ticket_uuid": "c6e36736-3fc5-11e3-ad45-4ff5aeba4d70"
            "created_at": "2013-10-28T11:46:01.321Z",
            "server_uuid": "42e66c8e-3fc6-11e3-a7cb-eb7cef96d803"
            "scope": "dataset",
            "id": "7a61f81c-3fc7-11e3-b0ed-83ee11549449"
        }
    ]
