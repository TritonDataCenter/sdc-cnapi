#!/bin/bash

export PATH=/usr:/usr/bin:/usr/sbin:/sbin

function get_zpool_disks()
{
   local zpool=$1
   Zpool_disks=

   for disk in $(/usr/bin/disklist -n); do
       local disk_in_pool=$(/usr/sbin/zpool status ${zpool} | grep ${disk})
       if [[ -n ${disk_in_pool} ]]; then
           Zpool_disks="${Zpool_disks},${disk}"
       fi
   done

   Zpool_disks=${Zpool_disks/#,/}
}

function get_zpool_profile()
{
   local zpool=$1
   local profiles=( mirror raidz3 raidz2 raidz )
   Zpool_profile="striped"

   for profile in ${profiles[*]}; do
       if [[ -n $(/usr/sbin/zpool status ${zpool} | grep ${profile}) ]]; then
           Zpool_profile=${profile}
           break
       fi
   done
}

function get_zpool()
{
   if [[ $(zpool list) != "no pools available" ]]; then
       Zpool=$(zpool list -H | awk '{print $1}');

       local used=$(zfs get -Hp -o value used ${Zpool})
       local available=$(zfs get -Hp -o value available ${Zpool})
       local size=$(( $used + $available ))
       Zpool_size=$(($size / 1024 / 1024 / 1024))

       get_zpool_disks ${Zpool}
       get_zpool_profile ${Zpool}
   fi
}

get_zpool

boot_time=$(/usr/bin/kstat -p -m unix -n system_misc -s boot_time | cut -f2)


cat << __END__;
{
    "boot_time": $boot_time,
    "zpool": "${Zpool}",
    "zpool_disks": "${Zpool_disks}",
    "zpool_profile": "${Zpool_profile}",
    "zpool_size": $(if [[ -z $Zpool_size ]]; then echo 0; else echo $Zpool_size ; fi)
}
__END__
