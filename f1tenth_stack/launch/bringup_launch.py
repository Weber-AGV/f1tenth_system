# MIT License

# Copyright (c) 2025 Hongrui Zheng

# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:

# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.

# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

from launch import LaunchDescription
from launch_ros.actions import Node
from launch.substitutions import LaunchConfiguration
from launch.actions import DeclareLaunchArgument
from launch.actions import ExecuteProcess
from launch.actions import IncludeLaunchDescription
from launch.conditions import IfCondition
from launch_xml.launch_description_sources import XMLLaunchDescriptionSource
from ament_index_python.packages import get_package_share_directory
import os


def generate_launch_description():
    joy_teleop_config = os.path.join(
        get_package_share_directory('f1tenth_stack'),
        'config',
        'joy_teleop.yaml'
    )
    vesc_config = os.path.join(
        get_package_share_directory('f1tenth_stack'),
        'config',
        'vesc.yaml'
    )
    sensors_config = os.path.join(
        get_package_share_directory('f1tenth_stack'),
        'config',
        'sensors.yaml'
    )
    mux_config = os.path.join(
        get_package_share_directory('f1tenth_stack'),
        'config',
        'mux.yaml'
    )

    joy_la = DeclareLaunchArgument(
        'joy_config',
        default_value=joy_teleop_config,
        description='Descriptions for joy and joy_teleop configs')
    vesc_la = DeclareLaunchArgument(
        'vesc_config',
        default_value=vesc_config,
        description='Descriptions for vesc configs')
    sensors_la = DeclareLaunchArgument(
        'sensors_config',
        default_value=sensors_config,
        description='Descriptions for sensor configs')
    mux_la = DeclareLaunchArgument(
        'mux_config',
        default_value=mux_config,
        description='Descriptions for ackermann mux configs')
    use_lidar_la = DeclareLaunchArgument(
        'use_lidar',
        default_value='true',
        description='Start the lidar driver (urg_node)')
    use_camera_la = DeclareLaunchArgument(
        'use_camera',
        default_value='true',
        description='Start the GStreamer camera stream (not a ROS node - see dashboard docs)')
    use_diagnostics_la = DeclareLaunchArgument(
        'use_diagnostics',
        default_value='true',
        description='Start system_diagnostics, rosbridge, and the dashboard web server')
    camera_device_la = DeclareLaunchArgument(
        'camera_device',
        default_value='/dev/video4',
        description='V4L2 device the camera GStreamer pipeline reads from')
    port_la = DeclareLaunchArgument(
        'dashboard_port',
        default_value='8000',
        description='Port the dashboard web server listens on')

    ld = LaunchDescription([
        joy_la, vesc_la, sensors_la, mux_la,
        use_lidar_la, use_camera_la, use_diagnostics_la, camera_device_la, port_la
    ])

    joy_node = Node(
        package='joy',
        executable='joy_node',
        name='joy',
        parameters=[LaunchConfiguration('joy_config')]
    )
    joy_teleop_node = Node(
        package='joy_teleop',
        executable='joy_teleop',
        name='joy_teleop',
        parameters=[LaunchConfiguration('joy_config')]
    )
    ackermann_to_vesc_node = Node(
        package='vesc_ackermann',
        executable='ackermann_to_vesc_node',
        name='ackermann_to_vesc_node',
        parameters=[LaunchConfiguration('vesc_config')]
    )
    vesc_to_odom_node = Node(
        package='vesc_ackermann',
        executable='vesc_to_odom_node',
        name='vesc_to_odom_node',
        parameters=[LaunchConfiguration('vesc_config')]
    )
    vesc_driver_node = Node(
        package='vesc_driver',
        executable='vesc_driver_node',
        name='vesc_driver_node',
        parameters=[LaunchConfiguration('vesc_config')]
    )
    throttle_interpolator_node = Node(
        package='f1tenth_stack',
        executable='throttle_interpolator',
        name='throttle_interpolator',
        parameters=[LaunchConfiguration('vesc_config')]
    )
    urg_node = Node(
        package='urg_node',
        executable='urg_node_driver',
        name='urg_node',
        parameters=[LaunchConfiguration('sensors_config')],
        condition=IfCondition(LaunchConfiguration('use_lidar'))
    )
    ackermann_mux_node = Node(
        package='ackermann_mux',
        executable='ackermann_mux',
        name='ackermann_mux',
        parameters=[LaunchConfiguration('mux_config')],
        remappings=[('ackermann_cmd_out', 'ackermann_drive')]
    )
    static_tf_node = Node(
        package='tf2_ros',
        executable='static_transform_publisher',
        name='static_baselink_to_laser',
        arguments=['0.27', '0.0', '0.11', '0.0', '0.0', '0.0', 'base_link', 'laser']
    )

    # --- diagnostics dashboard: system_diagnostics + rosbridge + static server ---
    # CPU, temps, disk, network, USB - none of that is in ROS. This node reads it
    # and republishes it as a standard DiagnosticArray on /diagnostics, so rosbridge
    # carries it with no extra transport.
    system_diagnostics_node = Node(
        package='f1tenth_stack',
        executable='system_diagnostics',
        name='system_diagnostics',
        condition=IfCondition(LaunchConfiguration('use_diagnostics'))
    )
    rosbridge_launch = IncludeLaunchDescription(
        XMLLaunchDescriptionSource(
            os.path.join(
                get_package_share_directory('rosbridge_server'),
                'launch',
                'rosbridge_websocket_launch.xml'
            )
        ),
        # 0.0.0.0 = reachable from any laptop on the robot's network, which
        # the dashboard needs. rosbridge has no authentication, so anyone on
        # that network can also publish to the robot through it.
        #
        # Launch arguments are shared with included files: an argument named
        # "port" here would also become rosbridge's port (its XML declares
        # "port" too) and make it fight the web server for 8000. That is why
        # the web server's argument is called dashboard_port.
        launch_arguments={'address': '0.0.0.0'}.items(),
        condition=IfCondition(LaunchConfiguration('use_diagnostics'))
    )
    dashboard_server = ExecuteProcess(
        cmd=[
            'python3', '-m', 'http.server', LaunchConfiguration('dashboard_port'),
            '--bind', '0.0.0.0',
            '--directory', os.path.join(get_package_share_directory('f1tenth_stack'), 'dashboard')
        ],
        condition=IfCondition(LaunchConfiguration('use_diagnostics'))
    )

    # --- camera stream: NOT a ROS node. GStreamer owns the V4L2 device directly
    # and pushes MJPEG over a raw TCP sink; camera_http relays that TCP stream as
    # real HTTP so a browser <img> tag can read it. See dashboard docs.
    camera_gst = ExecuteProcess(
        cmd=[
            'gst-launch-1.0',
            'v4l2src', ['device=', LaunchConfiguration('camera_device')],
            '!', 'video/x-raw,format=YUY2,width=640,height=480,framerate=30/1',
            '!', 'videoconvert',
            '!', 'jpegenc',
            '!', 'multipartmux', 'boundary=robotcamera',
            '!', 'tcpserversink', 'host=0.0.0.0', 'port=8081'
        ],
        condition=IfCondition(LaunchConfiguration('use_camera'))
    )
    # Node, not `ros2 run`: launch runs the executable itself, so a stop's
    # SIGINT reaches camera_http. `ros2 run` does not pass SIGINT on, which
    # left camera_http waiting out launch's 5 s and then orphaned.
    camera_http_proxy = Node(
        package='f1tenth_stack',
        executable='camera_http',
        condition=IfCondition(LaunchConfiguration('use_camera'))
    )

    # finalize
    ld.add_action(joy_node)
    ld.add_action(joy_teleop_node)
    ld.add_action(ackermann_to_vesc_node)
    ld.add_action(vesc_to_odom_node)
    ld.add_action(vesc_driver_node)
    # ld.add_action(throttle_interpolator_node)
    ld.add_action(urg_node)
    ld.add_action(ackermann_mux_node)
    ld.add_action(static_tf_node)
    ld.add_action(system_diagnostics_node)
    ld.add_action(rosbridge_launch)
    ld.add_action(dashboard_server)
    ld.add_action(camera_gst)
    ld.add_action(camera_http_proxy)

    return ld
