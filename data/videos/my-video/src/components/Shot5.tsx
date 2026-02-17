import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import {Video} from '@remotion/media';
import React from 'react';

export const Shot5: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling:
	// Original instruction: 0-18s range. Target: 7.18s.
	// Ratio approx 0.4
	
	const rightFadeStart = Math.round((8 / 18) * durationInFrames);
	const rightFadeEnd = Math.round((12 / 18) * durationInFrames);
	const arrowStart = Math.round((12 / 18) * durationInFrames);

	// Left Image (Always visible)
	// "muted" - desaturated
	
	// Right Image (Fades in)
	// "soft blue" - blue tint
	const rightOpacity = interpolate(frame, [rightFadeStart, rightFadeEnd], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	// Arrow Animation
	const arrowOpacity = interpolate(frame, [arrowStart, arrowStart + 15], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});
	
	const arrowX = interpolate(frame, [arrowStart, arrowStart + 30], [-20, 0], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
		easing: Easing.out(Easing.quad),
	});

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			{/* Left Split */}
			<AbsoluteFill
				style={{
					width: '50%',
					left: 0,
					overflow: 'hidden',
				}}
			>
				<Img
					src={staticFile('sixteen_cake.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'grayscale(0.8) contrast(0.9)', // Muted
					}}
				/>
			</AbsoluteFill>

			{/* Right Split */}
			<AbsoluteFill
				style={{
					width: '50%',
					left: '50%',
					overflow: 'hidden',
					opacity: rightOpacity,
				}}
			>
				<Img
					src={staticFile('newborn_silhouette.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'grayscale(0.5)', // Base for tint
					}}
				/>
				{/* Soft Blue Overlay */}
				<AbsoluteFill
					style={{
						backgroundColor: 'rgba(100, 150, 255, 0.4)',
						mixBlendMode: 'overlay',
					}}
				/>
			</AbsoluteFill>

			{/* Arrow and Text */}
			<AbsoluteFill
				className="justify-center items-center"
				style={{
					opacity: arrowOpacity,
					transform: `translateX(${arrowX}px)`,
					zIndex: 10,
				}}
			>
				<div
					className="flex flex-row items-center bg-black/50 p-4 rounded-xl backdrop-blur-sm border border-white/20"
				>
					<span
						className="text-white text-6xl font-bold mr-4"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						→
					</span>
					<span
						className="text-white text-6xl font-bold uppercase"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						причина
					</span>
				</div>
			</AbsoluteFill>

			{/* Dust Particles Overlay */}
			<AbsoluteFill style={{opacity: 0.4, pointerEvents: 'none', mixBlendMode: 'screen'}}>
				<Video
					src={staticFile('dust_particles.mp4')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
					muted
					loop
				/>
			</AbsoluteFill>

			<Audio src={staticFile('shot5_voice.mp3')} />
		</AbsoluteFill>
	);
};
